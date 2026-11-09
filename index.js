require("dotenv").config();

const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const Database = require("better-sqlite3");
const http = require("http");

// ======================================
// إعدادات البوت
// ======================================
const BOT_TOKEN = process.env.BOT_TOKEN;
const API_KEY = process.env.API_KEY;
const API_URL = process.env.API_URL || "https://bot.tota.click/api/v2";
const OWNER_ID = String(process.env.OWNER_ID || "");
const POINTS_PER_USD = Number(process.env.POINTS_PER_USD || 1000);

// المكافآت بالدولار الافتراضي ثم تُحوّل إلى نقاط
const DAILY_REWARD_USD = 5000;
const REFERRAL_REWARD_USD = 1000;
const MILESTONE_REWARD_USD = 1000;
const REFERRAL_MILESTONE = 5;
const DAILY_COOLDOWN_MS = 24 * 60 * 60 * 1000;

const DAILY_REWARD = DAILY_REWARD_USD * POINTS_PER_USD;
const REFERRAL_REWARD = REFERRAL_REWARD_USD * POINTS_PER_USD;
const MILESTONE_REWARD = MILESTONE_REWARD_USD * POINTS_PER_USD;

if (!BOT_TOKEN || !API_KEY || !OWNER_ID) {
  throw new Error("يجب ضبط BOT_TOKEN و API_KEY و OWNER_ID في Render");
}
if (!Number.isSafeInteger(POINTS_PER_USD) || POINTS_PER_USD <= 0) {
  throw new Error("POINTS_PER_USD يجب أن يكون رقمًا صحيحًا موجبًا");
}

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const db = new Database("./database.sqlite");
const states = new Map();

let servicesCache = [];
let categoriesCache = [];
let loadingServices = null;
let botUsername = "";

db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  points INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS admins (
  id TEXT PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  service_id TEXT,
  service_name TEXT,
  link TEXT,
  quantity INTEGER,
  points INTEGER,
  status TEXT DEFAULT 'Pending',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS codes (
  code TEXT PRIMARY KEY,
  points INTEGER NOT NULL,
  uses INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS daily_claims (
  user_id TEXT PRIMARY KEY,
  claimed_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS referrals (
  referred_id TEXT PRIMARY KEY,
  referrer_id TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS referral_milestones (
  referrer_id TEXT NOT NULL,
  milestone INTEGER NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (referrer_id, milestone)
);
`);

db.prepare("INSERT OR IGNORE INTO admins (id) VALUES (?)").run(OWNER_ID);

const getUser = db.prepare("SELECT * FROM users WHERE id=?");

const insertUser = db.prepare(
  "INSERT OR IGNORE INTO users (id, points) VALUES (?, 0)"
);

function ensureUser(id) {
  insertUser.run(String(id));
}

function isAdmin(id) {
  return !!db.prepare(
    "SELECT id FROM admins WHERE id=?"
  ).get(String(id));
}

function getBalance(id) {
  ensureUser(id);
  return getUser.get(String(id)).points;
}

function addPoints(id, amount) {
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new Error("INVALID_POINTS");
  }

  ensureUser(id);

  db.prepare(
    "UPDATE users SET points=points+? WHERE id=?"
  ).run(amount, String(id));
}

function moneyPoints(usd) {
  return Math.round(usd * POINTS_PER_USD);
}

// ======================================
// مزود الخدمات
// ======================================
async function api(action, params = {}) {
  const body = new URLSearchParams();

  body.append("key", API_KEY);
  body.append("action", action);

  for (const [key, value] of Object.entries(params)) {
    body.append(key, String(value));
  }

  const response = await axios.post(
    API_URL,
    body.toString(),
    {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      timeout: 30000
    }
  );

  return response.data;
}

// ======================================
// جلب الخدمات
// ======================================
async function getServices(force = false) {
  if (!force && servicesCache.length) {
    return servicesCache;
  }

  if (loadingServices) {
    return loadingServices;
  }

  loadingServices = (async () => {
    const data = await api("services");

    if (!Array.isArray(data)) {
      throw new Error("رد API غير صالح عند جلب الخدمات");
    }

    servicesCache = data;

    categoriesCache = [
      ...new Set(
        data.map(s => s.category || "خدمات أخرى")
      )
    ];

    return servicesCache;
  })();

  try {
    return await loadingServices;
  } finally {
    loadingServices = null;
  }
}

function serviceId(s) {
  return String(s.service || s.id);
}

function serviceName(s) {
  return s.name || "خدمة بدون اسم";
}

function serviceCategory(s) {
  return s.category || "خدمات أخرى";
}

function serviceRate(s) {
  return Number(s.rate || s.price || 0);
}

function isCommentService(s) {
  const type = String(s.type || "").toLowerCase();
  const name = serviceName(s).toLowerCase();

  return (
    type.includes("comment") ||
    name.includes("comment") ||
    name.includes("تعليق")
  );
}

function calculateCost(service, quantity) {
  return Math.ceil(
    (serviceRate(service) * quantity / 1000) *
    POINTS_PER_USD
  );
}

// ======================================
// نظام الإحالات والمكافأة اليومية
// ======================================
function registerReferral(newUserId, referrerId) {
  newUserId = String(newUserId);
  referrerId = String(referrerId);

  if (!referrerId || newUserId === referrerId) {
    return null;
  }

  const transaction = db.transaction(() => {
    const existing = db.prepare(
      "SELECT referred_id FROM referrals WHERE referred_id=?"
    ).get(newUserId);

    if (existing || !getUser.get(referrerId)) {
      return null;
    }

    db.prepare(
      "INSERT INTO referrals (referred_id, referrer_id) VALUES (?, ?)"
    ).run(newUserId, referrerId);

    addPoints(referrerId, REFERRAL_REWARD);

    const count = db.prepare(
      "SELECT COUNT(*) AS n FROM referrals WHERE referrer_id=?"
    ).get(referrerId).n;

    let milestoneBonus = 0;

    if (count % REFERRAL_MILESTONE === 0) {
      const milestone = count / REFERRAL_MILESTONE;

      const inserted = db.prepare(
        "INSERT OR IGNORE INTO referral_milestones (referrer_id, milestone) VALUES (?, ?)"
      ).run(referrerId, milestone);

      if (inserted.changes) {
        addPoints(referrerId, MILESTONE_REWARD);
        milestoneBonus = MILESTONE_REWARD;
      }
    }

    return {
      count,
      referralBonus: REFERRAL_REWARD,
      milestoneBonus
    };
  });

  return transaction();
}

function claimDaily(userId) {
  userId = String(userId);

  const now = Date.now();

  const transaction = db.transaction(() => {
    ensureUser(userId);

    const previous = db.prepare(
      "SELECT claimed_at FROM daily_claims WHERE user_id=?"
    ).get(userId);

    if (
      previous &&
      now - previous.claimed_at < DAILY_COOLDOWN_MS
    ) {
      return {
        ok: false,
        remaining: DAILY_COOLDOWN_MS - (now - previous.claimed_at)
      };
    }

    db.prepare(`
      INSERT INTO daily_claims (user_id, claimed_at)
      VALUES (?, ?)
      ON CONFLICT(user_id)
      DO UPDATE SET claimed_at=excluded.claimed_at
    `).run(userId, now);

    addPoints(userId, DAILY_REWARD);

    return { ok: true };
  });

  return transaction();
}

async function sendEarnMenu(chatId, userId) {
  const count = db.prepare(
    "SELECT COUNT(*) AS n FROM referrals WHERE referrer_id=?"
  ).get(String(userId)).n;

  const link = botUsername
    ? `https://t.me/${botUsername}?start=${userId}`
    : "سيظهر رابطك بعد تحميل معلومات البوت";

  return bot.sendMessage(
    chatId,
    "🎁 جمع النقاط\n\n" +
    `🎁 المكافأة اليومية: ${DAILY_REWARD_USD}$ (${DAILY_REWARD.toLocaleString("en-US")} نقطة)\n` +
    `👥 دعوة صديق جديد: ${REFERRAL_REWARD_USD}$ (${REFERRAL_REWARD.toLocaleString("en-US")} نقطة)\n` +
    `🏆 كل ${REFERRAL_MILESTONE} إحالات: ${MILESTONE_REWARD_USD}$ إضافية\n\n` +
    `👥 عدد إحالاتك الناجحة: ${count}\n\n` +
    `🔗 رابط دعوتك:\n${link}\n\n` +
    "تُحتسب الدعوة عندما يدخل شخص جديد إلى البوت لأول مرة عبر رابطك.",
    {
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "🎁 استلام المكافأة اليومية",
              callback_data: "daily"
            }
          ],
          [
            {
              text: "🔄 تحديث رابط/إحصائيات الدعوة",
              callback_data: "earn"
            }
          ],
          [
            {
              text: "🔙 الرئيسية",
              callback_data: "home"
            }
          ]
        ]
      }
    }
  );
}

// ======================================
// القوائم الرئيسية
// ======================================
function mainMenu() {
  return {
    inline_keyboard: [
      [
        { text: "🛍 طلب الخدمات", callback_data: "services" },
        { text: "💰 رصيدي", callback_data: "balance" }
      ],
      [
        { text: "🎁 جمع النقاط", callback_data: "earn" },
        { text: "📦 طلباتي", callback_data: "orders" }
      ],
      [
        { text: "🎟️ استبدال كود", callback_data: "redeem" },
        { text: "🔄 تحديث الخدمات", callback_data: "refresh" }
      ],
      [
        { text: "ℹ️ معلومات", callback_data: "info" }
      ]
    ]
  };
}

async function showCategories(chatId) {
  await getServices();

  const keyboard = categoriesCache.map((category, index) => [
    {
      text: "📂 " + category,
      callback_data: "category:" + index
    }
  ]);

  keyboard.push([
    { text: "🔙 الرئيسية", callback_data: "home" }
  ]);

  return bot.sendMessage(
    chatId,
    "اختر القسم الذي تريده:",
    { reply_markup: { inline_keyboard: keyboard } }
  );
}

async function showCategory(chatId, index) {
  await getServices();

  const category = categoriesCache[index];

  if (!category) {
    return bot.sendMessage(chatId, "القسم غير موجود.");
  }

  const services = servicesCache.filter(
    s => serviceCategory(s) === category
  );

  const keyboard = services.slice(0, 50).map(s => [
    {
      text: serviceName(s) + " | " + serviceRate(s) + "$ لكل 1000",
      callback_data: "service:" + serviceId(s)
    }
  ]);

  keyboard.push([
    { text: "🔙 الأقسام", callback_data: "services" }
  ]);

  return bot.sendMessage(
    chatId,
    "📂 " + category + "\n\nاختر الخدمة:",
    { reply_markup: { inline_keyboard: keyboard } }
  );
}

// ======================================
// بدء البوت + رابط الإحالة
// ======================================
bot.onText(/^\/start(?:\s+(\d+))?$/, async (msg, match) => {
  try {
    const userId = String(msg.from.id);
    const wasNew = !getUser.get(userId);

    ensureUser(userId);

    let referralMessage = "";

    if (wasNew && match && match[1]) {
      const result = registerReferral(userId, match[1]);

      if (result) {
        referralMessage = "\n\n✅ تم تسجيل دخولك عبر دعوة صديق.";

        bot.sendMessage(
          String(match[1]),
          `🎉 دخل صديق جديد عبر رابطك!\n💰 مكافأتك: ${REFERRAL_REWARD.toLocaleString("en-US")} نقطة (${REFERRAL_REWARD_USD}$).` +
          (
            result.milestoneBonus
              ? `\n🏆 مكافأة ${REFERRAL_MILESTONE} إحالات: ${result.milestoneBonus.toLocaleString("en-US")} نقطة إضافية!`
              : ""
          )
        ).catch(() => {});
      }
    }

    await bot.sendMessage(
      msg.chat.id,
      "🏆 أهلاً بك في رشـق ARSLE'N 🔖\n\nاختر من القائمة:" +
      referralMessage,
      { reply_markup: mainMenu() }
    );

  } catch (error) {
    console.error("Start error:", error.message);

    bot.sendMessage(
      msg.chat.id,
      "⚠️ حدث خطأ أثناء بدء البوت."
    );
  }
});

// ======================================
// معالجة الأزرار
// ======================================
bot.on("callback_query", async query => {
  const chatId = query.message.chat.id;
  const userId = String(query.from.id);
  const data = query.data;

  await bot.answerCallbackQuery(query.id).catch(() => {});

  ensureUser(userId);

  try {
    if (data === "home") {
      states.delete(userId);

      return bot.sendMessage(
        chatId,
        "🏆 القائمة الرئيسية:",
        { reply_markup: mainMenu() }
      );
    }

    if (data === "services") {
      return showCategories(chatId);
    }

    if (data === "balance") {
      const balance = getBalance(userId);

      return bot.sendMessage(
        chatId,
        `💰 رصيدك الحالي: ${balance.toLocaleString("en-US")} نقطة\n` +
        `ما يعادل ${(balance / POINTS_PER_USD).toFixed(2)}$ افتراضيًا.`
      );
    }

    if (data === "earn") {
      return sendEarnMenu(chatId, userId);
    }

    if (data === "daily") {
      const result = claimDaily(userId);

      if (!result.ok) {
        const hours = Math.floor(result.remaining / 3600000);
        const minutes = Math.ceil(
          (result.remaining % 3600000) / 60000
        );

        return bot.sendMessage(
          chatId,
          `⏳ استلمت مكافأتك مؤخرًا. ارجع بعد ${hours} ساعة و${minutes} دقيقة.`
        );
      }

      return bot.sendMessage(
        chatId,
        `🎉 تم استلام مكافأتك اليومية!\n\n` +
        `💵 المكافأة: ${DAILY_REWARD_USD}$\n` +
        `💰 النقاط المضافة: ${DAILY_REWARD.toLocaleString("en-US")} نقطة\n` +
        `رصيدك الجديد: ${getBalance(userId).toLocaleString("en-US")} نقطة.`
      );
    }

    if (data === "info") {
      return bot.sendMessage(
        chatId,
        "🏆 رشـق ARSLE'N 🔖\n" +
        "خدمات متعددة وطلبات تلقائية.\n" +
        "النقاط رصيد افتراضي داخل البوت وليست أموالًا نقدية.\n" +
        "للدعم تواصل مع الإدارة."
      );
    }

    if (data === "refresh") {
      await getServices(true);

      return bot.sendMessage(
        chatId,
        "✅ تم تحديث الخدمات والأسعار."
      );
    }

    if (data === "redeem") {
      states.set(userId, { step: "redeem" });

      return bot.sendMessage(
        chatId,
        "🎁 أرسل كود النقاط:"
      );
    }

    if (data === "orders") {
      const orders = db.prepare(
        "SELECT * FROM orders WHERE user_id=? ORDER BY id DESC LIMIT 10"
      ).all(userId);

      if (!orders.length) {
        return bot.sendMessage(
          chatId,
          "ليس لديك طلبات حتى الآن."
        );
      }

      for (const order of orders) {
        let status = order.status;

        try {
          const result = await api("status", {
            order: order.provider_id
          });

          status = result.status || JSON.stringify(result);

        } catch (_) {
          status = "تعذر جلب الحالة";
        }

        await bot.sendMessage(
          chatId,
          `📦 الطلب: ${order.provider_id}\n` +
          `🛍 الخدمة: ${order.service_name}\n` +
          `🔢 الكمية: ${order.quantity}\n` +
          `📊 الحالة: ${status}\n\n` +
          `للتعويض: /refill ${order.provider_id}\n` +
          `للإلغاء: /cancel ${order.provider_id}`
        );
      }

      return;
    }

    if (data.startsWith("category:")) {
      return showCategory(
        chatId,
        Number(data.split(":")[1])
      );
    }

    if (data.startsWith("service:")) {
      await getServices();

      const id = data.split(":")[1];

      const service = servicesCache.find(
        s => serviceId(s) === id
      );

      if (!service) {
        return bot.sendMessage(
          chatId,
          "الخدمة غير موجودة."
        );
      }

      states.set(userId, {
        step: isCommentService(service) ? "comments" : "link",
        service
      });

      return bot.sendMessage(
        chatId,
        `🛍 ${serviceName(service)}\n` +
        `💵 السعر: ${serviceRate(service)}$ لكل 1000\n` +
        `📉 الحد الأدنى: ${service.min || 1}\n` +
        `📈 الحد الأقصى: ${service.max || "غير محدد"}\n\n` +
        (
          isCommentService(service)
            ? "💬 أرسل التعليقات، كل تعليق في سطر."
            : "📮 أرسل رابط المنشور أو الحساب."
        )
      );
    }

    if (data === "cancel_order") {
      states.delete(userId);

      return bot.sendMessage(
        chatId,
        "❌ تم إلغاء العملية."
      );
    }

    if (data === "confirm_order") {
      const state = states.get(userId);

      if (
        !state ||
        state.step !== "confirm" ||
        state.busy
      ) {
        return bot.sendMessage(
          chatId,
          "لا يوجد طلب جاهز للتأكيد."
        );
      }

      state.busy = true;

      if (getBalance(userId) < state.cost) {
        states.delete(userId);

        return bot.sendMessage(
          chatId,
          "❌ رصيدك غير كافٍ."
        );
      }

      const params = {
        service: serviceId(state.service),
        link: state.link
      };

      if (state.comments) {
        params.comments = state.comments;
      } else {
        params.quantity = state.quantity;
      }

      const result = await api("add", params);

      if (!result || !result.order) {
        states.delete(userId);

        return bot.sendMessage(
          chatId,
          "❌ لم يقبل المزوّد الطلب:\n" +
          JSON.stringify(result)
        );
      }

      const debit = db.transaction(() => {
        const user = getUser.get(userId);

        if (!user || user.points < state.cost) {
          throw new Error("INSUFFICIENT_BALANCE");
        }

        db.prepare(
          "UPDATE users SET points=points-? WHERE id=?"
        ).run(state.cost, userId);

        db.prepare(`
          INSERT INTO orders (
            user_id,
            provider_id,
            service_id,
            service_name,
            link,
            quantity,
            points,
            status
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          userId,
          String(result.order),
          serviceId(state.service),
          serviceName(state.service),
          state.link,
          state.quantity,
          state.cost,
          "Pending"
        );
      });

      debit();
      states.delete(userId);

      return bot.sendMessage(
        chatId,
        `✅ تم إرسال طلبك بنجاح!\n\n` +
        `🆔 رقم الطلب: ${result.order}\n` +
        `🛍 الخدمة: ${serviceName(state.service)}\n` +
        `🔢 الكمية: ${state.quantity}\n` +
        `💰 المخصوم: ${state.cost.toLocaleString("en-US")} نقطة`
      );
    }

  } catch (error) {
    console.error(
      "Callback error:",
      error.response?.data || error.message
    );

    const state = states.get(userId);

    if (state) {
      state.busy = false;
    }

    await bot.sendMessage(
      chatId,
      "⚠️ حدث خطأ. حاول مرة أخرى."
    );
  }
});

// ======================================
// استقبال رسائل المستخدمين
// ======================================
bot.on("message", async msg => {
  if (!msg.text || msg.text.startsWith("/")) {
    return;
  }

  const userId = String(msg.from.id);
  const chatId = msg.chat.id;
  const state = states.get(userId);

  if (!state || state.busy) {
    return;
  }

  ensureUser(userId);

  try {
    if (state.step === "redeem") {
      const code = msg.text.trim().toUpperCase();

      const redeem = db.transaction(() => {
        const item = db.prepare(
          "SELECT * FROM codes WHERE code=? AND uses>0"
        ).get(code);

        if (!item) {
          return null;
        }

        const changed = db.prepare(
          "UPDATE codes SET uses=uses-1 WHERE code=? AND uses>0"
        ).run(code);

        if (!changed.changes) {
          return null;
        }

        db.prepare(
          "UPDATE users SET points=points+? WHERE id=?"
        ).run(item.points, userId);

        return item;
      });

      const item = redeem();

      states.delete(userId);

      if (!item) {
        return bot.sendMessage(
          chatId,
          "❌ الكود غير صحيح أو انتهت استخداماته."
        );
      }

      return bot.sendMessage(
        chatId,
        `✅ تمت إضافة ${item.points.toLocaleString("en-US")} نقطة إلى رصيدك.`
      );
    }

    if (state.step === "comments") {
      const lines = msg.text
        .split(/\r?\n/)
        .map(x => x.trim())
        .filter(Boolean);

      if (!lines.length) {
        return bot.sendMessage(
          chatId,
          "❌ أرسل تعليقًا واحدًا على الأقل."
        );
      }

      const min = Number(state.service.min || 1);
      const max = Number(state.service.max || 2147483647);

      if (lines.length < min || lines.length > max) {
        return bot.sendMessage(
          chatId,
          `❌ عدد التعليقات غير صحيح. الحد الأدنى ${min} والحد الأقصى ${max}.`
        );
      }

      state.comments = lines.join("\n");
      state.quantity = lines.length;
      state.step = "link";

      return bot.sendMessage(
        chatId,
        "📮 أرسل رابط المنشور الذي تريد التعليق عليه:"
      );
    }

    if (state.step === "link") {
      const link = msg.text.trim();

      if (!/^https?:\/\/\S+$/i.test(link)) {
        return bot.sendMessage(
          chatId,
          "❌ أرسل رابطًا صحيحًا يبدأ بـ https:// أو http://"
        );
      }

      state.link = link;

      if (state.comments) {
        state.cost = calculateCost(
          state.service,
          state.quantity
        );

        state.step = "confirm";

        if (getBalance(userId) < state.cost) {
          states.delete(userId);

          return bot.sendMessage(
            chatId,
            `❌ رصيدك غير كافٍ.\n` +
            `السعر: ${state.cost} نقطة\n` +
            `رصيدك: ${getBalance(userId)} نقطة`
          );
        }

        return sendOrderConfirmation(chatId, state);
      }

      state.step = "quantity";

      return bot.sendMessage(
        chatId,
        "🔢 أرسل الكمية المطلوبة:"
      );
    }

    if (state.step === "quantity") {
      const quantity = Number(msg.text.trim());

      const min = Number(state.service.min || 1);
      const max = Number(state.service.max || 2147483647);

      if (
        !Number.isSafeInteger(quantity) ||
        quantity < min ||
        quantity > max
      ) {
        return bot.sendMessage(
          chatId,
          `❌ الكمية غير صحيحة.\n` +
          `الحد الأدنى: ${min}\n` +
          `الحد الأقصى: ${max}`
        );
      }

      state.quantity = quantity;

      state.cost = calculateCost(
        state.service,
        quantity
      );

      state.step = "confirm";

      if (getBalance(userId) < state.cost) {
        states.delete(userId);

        return bot.sendMessage(
          chatId,
          `❌ رصيدك غير كافٍ.\n` +
          `السعر: ${state.cost} نقطة\n` +
          `رصيدك: ${getBalance(userId)} نقطة`
        );
      }

      return sendOrderConfirmation(chatId, state);
    }

  } catch (error) {
    console.error(
      "Message error:",
      error.response?.data || error.message
    );

    states.delete(userId);

    bot.sendMessage(
      chatId,
      "⚠️ حدث خطأ أثناء العملية."
    );
  }
});

// ======================================
// رسالة تأكيد الطلب
// ======================================
function sendOrderConfirmation(chatId, state) {
  return bot.sendMessage(
    chatId,
    `📋 تأكيد الطلب\n\n` +
    `الخدمة: ${serviceName(state.service)}\n` +
    `الكمية: ${state.quantity}\n` +
    `السعر: ${state.cost.toLocaleString("en-US")} نقطة\n` +
    `الرابط: ${state.link}\n\n` +
    `هل تريد التنفيذ؟`,
    {
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "✅ تأكيد",
              callback_data: "confirm_order"
            },
            {
              text: "❌ إلغاء",
              callback_data: "cancel_order"
            }
          ]
        ]
      }
    }
  );
}

// ======================================
// أوامر الإدارة
// ======================================

// إضافة نقاط:
// /addpoints USER_ID AMOUNT
bot.onText(/^\/addpoints (\d+) (\d+)$/, async (msg, match) => {
  if (!isAdmin(msg.from.id)) {
    return;
  }

  const userId = match[1];
  const amount = Number(match[2]);

  if (!Number.isSafeInteger(amount) || amount <= 0) {
    return bot.sendMessage(
      msg.chat.id,
      "❌ عدد النقاط غير صالح."
    );
  }

  addPoints(userId, amount);

  bot.sendMessage(
    msg.chat.id,
    `✅ تمت إضافة ${amount.toLocaleString("en-US")} نقطة للمستخدم ${userId}`
  );

  bot.sendMessage(
    userId,
    `🎁 تمت إضافة ${amount.toLocaleString("en-US")} نقطة إلى رصيدك.`
  ).catch(() => {});
});

// إنشاء كود:
// /createcode POINTS USES
bot.onText(/^\/createcode (\d+) (\d+)$/, (msg, match) => {
  if (!isAdmin(msg.from.id)) {
    return;
  }

  const points = Number(match[1]);
  const uses = Number(match[2]);

  if (
    !Number.isSafeInteger(points) ||
    points <= 0 ||
    !Number.isSafeInteger(uses) ||
    uses <= 0
  ) {
    return bot.sendMessage(
      msg.chat.id,
      "❌ تحقق من النقاط وعدد الاستخدامات."
    );
  }

  const code = Math.random()
    .toString(36)
    .slice(2, 10)
    .toUpperCase();

  db.prepare(
    "INSERT INTO codes (code, points, uses) VALUES (?, ?, ?)"
  ).run(code, points, uses);

  bot.sendMessage(
    msg.chat.id,
    `🎁 تم إنشاء الكود\n\n` +
    `الكود: ${code}\n` +
    `النقاط: ${points}\n` +
    `عدد الاستخدامات: ${uses}`
  );
});

// إضافة مدير:
// /addadmin USER_ID
bot.onText(/^\/addadmin (\d+)$/, (msg, match) => {
  if (String(msg.from.id) !== OWNER_ID) {
    return;
  }

  db.prepare(
    "INSERT OR IGNORE INTO admins (id) VALUES (?)"
  ).run(match[1]);

  bot.sendMessage(
    msg.chat.id,
    "✅ تمت إضافة المدير."
  );
});

// حذف مدير:
// /deladmin USER_ID
bot.onText(/^\/deladmin (\d+)$/, (msg, match) => {
  if (String(msg.from.id) !== OWNER_ID) {
    return;
  }

  if (match[1] === OWNER_ID) {
    return bot.sendMessage(
      msg.chat.id,
      "لا يمكن حذف المالك."
    );
  }

  db.prepare(
    "DELETE FROM admins WHERE id=?"
  ).run(match[1]);

  bot.sendMessage(
    msg.chat.id,
    "✅ تم حذف المدير."
  );
});

// عرض المديرين:
// /admins
bot.onText(/^\/admins$/, msg => {
  if (!isAdmin(msg.from.id)) {
    return;
  }

  const admins = db.prepare(
    "SELECT id FROM admins"
  ).all();

  bot.sendMessage(
    msg.chat.id,
    "👑 قائمة المديرين:\n" +
    admins.map(a => a.id).join("\n")
  );
});

// حذف كود:
// /delcode CODE
bot.onText(/^\/delcode (.+)$/, (msg, match) => {
  if (!isAdmin(msg.from.id)) {
    return;
  }

  db.prepare(
    "DELETE FROM codes WHERE code=?"
  ).run(match[1].trim().toUpperCase());

  bot.sendMessage(
    msg.chat.id,
    "🗑 تم حذف الكود."
  );
});

// ======================================
// التعويض
// /refill ORDER_ID
// ======================================
bot.onText(/^\/refill (\d+)$/, async (msg, match) => {
  const userId = String(msg.from.id);

  const order = db.prepare(
    "SELECT * FROM orders WHERE provider_id=? AND user_id=?"
  ).get(match[1], userId);

  if (!order) {
    return bot.sendMessage(
      msg.chat.id,
      "❌ الطلب غير موجود في حسابك."
    );
  }

  try {
    const result = await api("refill", {
      order: match[1]
    });

    if (result.refill) {
      return bot.sendMessage(
        msg.chat.id,
        "✅ تم إرسال طلب التعويض.\nرقم التعويض: " + result.refill
      );
    }

    return bot.sendMessage(
      msg.chat.id,
      "رد المزوّد:\n" + JSON.stringify(result)
    );

  } catch (error) {
    console.error(
      "Refill error:",
      error.response?.data || error.message
    );

    bot.sendMessage(
      msg.chat.id,
      "⚠️ تعذر طلب التعويض."
    );
  }
});

// ======================================
// إلغاء الطلب
// /cancel ORDER_ID
// ======================================
bot.onText(/^\/cancel (\d+)$/, async (msg, match) => {
  const userId = String(msg.from.id);

  const order = db.prepare(
    "SELECT * FROM orders WHERE provider_id=? AND user_id=?"
  ).get(match[1], userId);

  if (!order) {
    return bot.sendMessage(
      msg.chat.id,
      "❌ الطلب غير موجود في حسابك."
    );
  }

  try {
    const result = await api("cancel", {
      orders: match[1]
    });

    bot.sendMessage(
      msg.chat.id,
      "📨 رد المزوّد:\n" + JSON.stringify(result)
    );

  } catch (error) {
    console.error(
      "Cancel error:",
      error.response?.data || error.message
    );

    bot.sendMessage(
      msg.chat.id,
      "⚠️ تعذر إلغاء الطلب."
    );
  }
});

// ======================================
// خادم Render
// ======================================
const server = http.createServer((req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/plain; charset=utf-8"
  });

  res.end("ARSLE'N BOT is running");
});

server.listen(
  process.env.PORT || 3000,
  "0.0.0.0",
  () => console.log("Web server started")
);

// ======================================
// تشغيل البوت
// ======================================
bot.on("polling_error", error => {
  console.error(
    "Telegram polling error:",
    error.message
  );
});

process.on("uncaughtException", error => {
  console.error("Uncaught exception:", error);
});

process.on("unhandledRejection", error => {
  console.error("Unhandled rejection:", error);
});

(async () => {
  try {
    const me = await bot.getMe();

    botUsername = me.username || "";

    console.log("Bot username:", botUsername);

  } catch (error) {
    console.error(
      "Could not get bot username:",
      error.message
    );
  }
})();

console.log("ARSLE'N BOT started!");

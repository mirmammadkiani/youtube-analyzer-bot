// ============================================================
//  Telegram Bot on Cloudflare Worker — YouTube Analyzer
//  Gemini 3.5 Flash · Admin access control · Analytics & Usage Stats
// ============================================================

// متغیرهای پیکربندی و اعتبارسنجی (به صورت خودکار از Cloudflare Secrets یا .dev.vars بارگذاری می‌شوند)
let TELEGRAM_TOKEN = "";
let ADMIN_ID = 0;
let GEMINI_KEYS = [];

function setupConfig(env) {
  if (!env) return;
  if (env.TELEGRAM_TOKEN) TELEGRAM_TOKEN = env.TELEGRAM_TOKEN;
  if (env.ADMIN_ID) ADMIN_ID = parseInt(env.ADMIN_ID, 10) || 0;
  if (env.GEMINI_KEYS) {
    if (Array.isArray(env.GEMINI_KEYS)) {
      GEMINI_KEYS = env.GEMINI_KEYS;
    } else if (typeof env.GEMINI_KEYS === "string") {
      try {
        const parsed = JSON.parse(env.GEMINI_KEYS);
        GEMINI_KEYS = Array.isArray(parsed) ? parsed : [env.GEMINI_KEYS];
      } catch {
        GEMINI_KEYS = env.GEMINI_KEYS.split(",").map((k) => k.trim()).filter(Boolean);
      }
    }
  }
}

// ترتیب مدل‌ها: اولویت با مدل‌های تست‌شده، فوق‌سریع و پایدار بدون خطای ۵۰۳
const GEMINI_MODELS = [
  "gemini-3.5-flash-lite",    // نسخه ۳.۵ لایت فوق‌سریع و پایدار (پاسخ در کمتر از ۱ ثانیه)
  "gemini-3.1-flash-lite",    // نسخه ۳.۱ لایت بسیار پایدار و بدون افت سرعت
  "gemini-3.5-flash",         // نسخه ۳.۵ با دقت و کیفیت بالا
];

const MODEL_LABELS = {
  "gemini-3.5-flash-lite": "Google Gemini 3.5 Flash Lite",
  "gemini-3.1-flash-lite": "Google Gemini 3.1 Flash Lite",
  "gemini-3.5-flash": "Google Gemini 3.5 Flash",
};

// ─── Telegram API helpers ────────────────────────────────────
const TG = (method) => `https://api.telegram.org/bot${TELEGRAM_TOKEN}/${method}`;

async function tgCall(method, body) {
  const res = await fetch(TG(method), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function sendMessage(chat_id, text, extra = {}) {
  return tgCall("sendMessage", {
    chat_id,
    text,
    parse_mode: "HTML",
    ...extra,
  });
}

async function editMessage(chat_id, message_id, text, extra = {}) {
  return tgCall("editMessageText", {
    chat_id,
    message_id,
    text,
    parse_mode: "HTML",
    ...extra,
  });
}

async function answerCallback(callback_query_id, text = "", show_alert = false) {
  return tgCall("answerCallbackQuery", { callback_query_id, text, show_alert });
}

async function sendTyping(chat_id) {
  return tgCall("sendChatAction", { chat_id, action: "typing" });
}

// ─── KV Data Helpers ─────────────────────────────────────────
async function getAllowedUsers(env) {
  const raw = await env.BOT_KV.get("users");
  if (!raw) return [ADMIN_ID];
  try {
    const list = JSON.parse(raw);
    if (!list.includes(ADMIN_ID)) list.push(ADMIN_ID);
    return list;
  } catch {
    return [ADMIN_ID];
  }
}

async function setAllowedUsers(env, users) {
  await env.BOT_KV.put("users", JSON.stringify([...new Set(users)]));
}

async function isAllowed(env, userId) {
  if (userId === ADMIN_ID) return true;
  const users = await getAllowedUsers(env);
  return users.includes(userId);
}

// ثبت آمار استفاده هر کاربر
async function recordUsage(env, userId, userName, userUsername, videoTitle) {
  const key = `stats_${userId}`;
  const raw = await env.BOT_KV.get(key);
  let data = {
    userId,
    name: userName || "نامشخص",
    username: userUsername || null,
    totalCount: 0,
    lastUsed: null,
    history: [],
  };

  if (raw) {
    try {
      data = { ...data, ...JSON.parse(raw) };
    } catch {}
  }

  data.totalCount += 1;
  data.lastUsed = new Date().toISOString();
  if (userName) data.name = userName;
  if (userUsername) data.username = userUsername;

  data.history = data.history || [];
  data.history.unshift({
    time: new Date().toISOString(),
  });
  if (data.history.length > 5) data.history = data.history.slice(0, 5);

  await env.BOT_KV.put(key, JSON.stringify(data));
}

async function getUserStats(env, userId) {
  const raw = await env.BOT_KV.get(`stats_${userId}`);
  if (!raw) {
    return {
      userId,
      name: "بدون سابقه",
      totalCount: 0,
      lastUsed: "هنوز استفاده نکرده",
      history: [],
    };
  }
  try {
    return JSON.parse(raw);
  } catch {
    return { userId, name: "نامشخص", totalCount: 0, lastUsed: null, history: [] };
  }
}

// ثبت یا به‌روزرسانی مشخصات کاربر (نام و یوزرنیم) در حافظه
async function ensureUserProfile(env, userId, userName, userUsername) {
  try {
    const key = `stats_${userId}`;
    const raw = await env.BOT_KV.get(key);
    let data = null;
    if (raw) {
      try { data = JSON.parse(raw); } catch {}
    }
    if (!data) {
      data = {
        userId,
        name: userName || "نامشخص",
        username: userUsername || null,
        totalCount: 0,
        lastUsed: null,
        history: [],
      };
      await env.BOT_KV.put(key, JSON.stringify(data));
    } else {
      let changed = false;
      if (userName && data.name !== userName && (!data.name || data.name === "نامشخص" || data.name === "بدون سابقه" || data.name === "کاربر تلگرام")) {
        data.name = userName;
        changed = true;
      }
      if (userUsername && data.username !== userUsername) {
        data.username = userUsername;
        changed = true;
      }
      if (changed) {
        await env.BOT_KV.put(key, JSON.stringify(data));
      }
    }
  } catch {}
}

// دریافت مشخصات کاربر با استعلام زنده از API تلگرام در صورت ناقص بودن
async function getOrFetchUserInfo(env, userId) {
  let stats = await getUserStats(env, userId);
  if (!stats.name || stats.name === "بدون سابقه" || stats.name === "نامشخص" || stats.name === "کاربر تلگرام" || !stats.username) {
    try {
      const chatRes = await tgCall("getChat", { chat_id: userId });
      if (chatRes && chatRes.ok && chatRes.result) {
        const c = chatRes.result;
        const realName = [c.first_name, c.last_name].filter(Boolean).join(" ");
        if (realName) stats.name = realName;
        if (c.username) stats.username = c.username;
        if (c.bio) stats.bio = c.bio;
        await env.BOT_KV.put(`stats_${userId}`, JSON.stringify(stats));
      }
    } catch {}
  }
  return stats;
}

// مدیریت لینک دونیت (حمایت مالی)
async function getDonateLink(env) {
  return await env.BOT_KV.get("donate_link");
}

async function setDonateLink(env, url) {
  if (!url || url.trim() === "" || url.trim() === "0" || url.trim() === "delete") {
    await env.BOT_KV.delete("donate_link");
  } else {
    await env.BOT_KV.put("donate_link", url.trim());
  }
}

// ─── مدیریت لاگ‌ها و سیستم مانیتورینگ ادمین ───────────────────
async function addSystemLog(env, type, message, details = {}) {
  const logEntry = {
    time: new Date().toISOString(),
    type, // 'ERROR' | 'INFO' | 'SUCCESS'
    message: String(message || ""),
    details,
  };

  try {
    const raw = await env.BOT_KV.get("system_logs");
    let logs = [];
    if (raw) {
      try { logs = JSON.parse(raw); } catch {}
    }
    logs.unshift(logEntry);
    if (logs.length > 30) logs = logs.slice(0, 30);
    await env.BOT_KV.put("system_logs", JSON.stringify(logs));
  } catch {}

  // ارسال فوری خطا به ادمین در تلگرام
  if (type === "ERROR") {
    try {
      const timeStr = new Date().toLocaleTimeString("fa-IR");
      let errAlert = `🚨 <b>گزارش خطای سیستم (لاگ اختصاصی ادمین):</b>\n\n` +
        `⏱ زمان: <code>${timeStr}</code>\n` +
        `📌 رخداد: <b>${escapeHtml(logEntry.message)}</b>\n`;

      if (details.userId) {
        errAlert += `👤 شناسه کاربر: <code>${details.userId}</code>\n`;
      }
      if (details.error) {
        errAlert += `❌ متن خطا:\n<pre>${escapeHtml(String(details.error).substring(0, 500))}</pre>`;
      }

      await sendMessage(ADMIN_ID, errAlert);
    } catch {}
  }
}

async function getSystemLogs(env) {
  try {
    const raw = await env.BOT_KV.get("system_logs");
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

// ─── تنظیمات حالت تایید عضویت (Whitelist) و عضوگیری (Registration) ──
async function isWhitelistEnabled(env) {
  const val = await env.BOT_KV.get("setting_whitelist_mode");
  return val !== "off"; // پیش‌فرض: روشن (نیاز به تایید دستی ادمین)
}

async function setWhitelistEnabled(env, enabled) {
  await env.BOT_KV.put("setting_whitelist_mode", enabled ? "on" : "off");
}

async function isRegistrationOpen(env) {
  const val = await env.BOT_KV.get("setting_registration_mode");
  return val !== "closed"; // پیش‌فرض: باز (پذیرش کاربران جدید فعال است)
}

async function setRegistrationOpen(env, open) {
  await env.BOT_KV.put("setting_registration_mode", open ? "open" : "closed");
}

// ─── همگام‌سازی بیوگرافی و منوی دستورات ربات در تلگرام ──────────
async function syncBotProfile() {
  try {
    await tgCall("setMyDescription", {
      description:
        "🎬 به ربات تحلیلگر هوشمند ویدیوهای یوتیوب خوش آمدید!\n\n" +
        "با این ربات بدون نیاز به دانلود یا تماشای کامل ویدیوهای طولانی، در چند ثانیه به محتوا، چکیده، شرح صحنه‌به‌صحنه با تایم‌استمپ دقیق کلیک‌پذیر و نکات کلیدی هر ویدیو به زبان فارسی دسترسی پیدا کنید.\n\n" +
        "برای شروع، کافیست دکمه Start را لمس کنید.",
    });

    await tgCall("setMyShortDescription", {
      short_description:
        "🎬 تحلیل، خلاصه‌سازی و شرح صحنه‌به‌صحنه ویدیوهای یوتیوب به زبان فارسی با هوش مصنوعی Google Gemini",
    });

    await tgCall("setMyCommands", {
      commands: [
        { command: "start", description: "شروع به کار و منوی اصلی" },
        { command: "help", description: "راهنمای استفاده و معرفی حالات تحلیل" },
        { command: "status", description: "مشاهده وضعیت حساب و تعداد تحلیل‌ها" },
        { command: "support", description: "ارتباط با پشتیبانی و ارسال پیام به ادمین" },
        { command: "admin", description: "ورود به پنل مدیریت (مخصوص ادمین)" },
      ],
    });
    return true;
  } catch {
    return false;
  }
}

// ─── مانیتورینگ سهمیه و مصرف روزانه کلیدها ───────────────────
async function recordKeyUsage(env, keyIndex, model) {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const key = `quota_${today}_key_${keyIndex}`;
    const totalKey = `quota_${today}_total`;
    const current = parseInt((await env.BOT_KV.get(key)) || "0");
    const currentTotal = parseInt((await env.BOT_KV.get(totalKey)) || "0");
    // ذخیره آمار تا ۷ روز در KV
    await env.BOT_KV.put(key, String(current + 1), { expirationTtl: 604800 });
    await env.BOT_KV.put(totalKey, String(currentTotal + 1), { expirationTtl: 604800 });
  } catch {}
}

async function getQuotaReport(env) {
  const today = new Date().toISOString().slice(0, 10);
  const totalKey = `quota_${today}_total`;
  const totalToday = parseInt((await env.BOT_KV.get(totalKey)) || "0");

  const DAILY_LIMIT_PER_KEY = 1500; // سقف رسمی پلن رایگان گوگل استودیو برای هر کلید در روز
  const TOTAL_DAILY_LIMIT = DAILY_LIMIT_PER_KEY * GEMINI_KEYS.length; // ۴۵۰۰ درخواست در روز

  let report = `📊 <b>داشبورد سهمیه و ظرفیت کلیدهای هوش مصنوعی:</b>\n\n` +
    `📅 تاریخ: <code>${today}</code> (${new Date().toLocaleDateString("fa-IR")})\n` +
    `📈 مجموع درخواست‌های امروز: <b>${totalToday}</b> از <b>${TOTAL_DAILY_LIMIT}</b>\n`;

  const totalPercent = Math.min(100, (totalToday / TOTAL_DAILY_LIMIT) * 100).toFixed(1);
  const totalRemaining = Math.max(0, TOTAL_DAILY_LIMIT - totalToday);
  report += `📊 درصد مصرف کل: <b>${totalPercent}%</b> (باقی‌مانده: <b>${totalRemaining}</b> ویدیو)\n\n` +
    `🔑 <b>وضعیت تفکیکی کلیدها:</b>\n`;

  for (let i = 0; i < GEMINI_KEYS.length; i++) {
    const keyIndex = i + 1;
    const used = parseInt((await env.BOT_KV.get(`quota_${today}_key_${keyIndex}`)) || "0");
    const remaining = Math.max(0, DAILY_LIMIT_PER_KEY - used);
    const percent = Math.min(100, (used / DAILY_LIMIT_PER_KEY) * 100).toFixed(1);

    let tag = "🟩";
    if (percent > 80) tag = "🟥";
    else if (percent > 50) tag = "🟨";

    report += `\n${tag} <b>کلید ${keyIndex}:</b>\n` +
      `   • مصرف: <b>${used}</b> / ${DAILY_LIMIT_PER_KEY} درخواست (${percent}%)\n` +
      `   • باقی‌مانده: <b>${remaining}</b> درخواست\n`;
  }

  report += `\n⚡️ <b>ظرفیت لحظه‌ای و سرعت (RPM):</b>\n` +
    `• سقف مجاز: <b>${15 * GEMINI_KEYS.length} درخواست/دقیقه</b> (۱۵ تا به ازای هر کلید)\n` +
    `• مدل‌های فعال:\n  ▫️ <code>${GEMINI_MODELS.join("</code>\n  ▫️ <code>")}</code>\n\n` +
    `💡 <i>سهمیه روزانه گوگل ساعت ۰۳:۳۰ بامداد ایران صفر و مجدداً شارژ می‌شود.</i>`;

  return report;
}

async function testKeysHealth() {
  const results = [];
  const testModel = GEMINI_MODELS[0]; // gemini-3.5-flash-lite

  for (let i = 0; i < GEMINI_KEYS.length; i++) {
    const key = GEMINI_KEYS[i];
    const start = Date.now();
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${testModel}:generateContent?key=${key}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(6000),
        body: JSON.stringify({ contents: [{ parts: [{ text: "ping" }] }] }),
      });
      const latency = Date.now() - start;
      if (res.ok) {
        results.push(`✅ <b>کلید ${i + 1}:</b> متصل و سالم (پاسخ: ${latency} میلی‌ثانیه)`);
      } else {
        const d = await res.json().catch(() => ({}));
        results.push(`⚠️ <b>کلید ${i + 1}:</b> خطا (${res.status}) - ${escapeHtml(d?.error?.message || "نامشخص")}`);
      }
    } catch (e) {
      results.push(`❌ <b>کلید ${i + 1}:</b> قطعی یا تایم‌اوت (${e.message})`);
    }
  }
  return results.join("\n");
}

// ─── کش کردن تحلیل‌ها در KV برای صفر کردن مصرف توکن ─────────
async function getCachedAnalysis(env, videoId, mode) {
  if (!env || !env.BOT_KV) return null;
  try {
    const raw = await env.BOT_KV.get(`cache_${mode}_${videoId}`);
    if (raw) {
      const data = JSON.parse(raw);
      if (data && data.result) {
        // در صورتی که این پیام قبلاً ذخیره شده و شامل فرمول‌های لاتکس خام باشد،
        // آن را در لحظه اصلاح کرده و نسخه تمیز را به طور خودکار در KV ذخیره می‌کنیم
        if (hasLatexMath(data.result)) {
          data.result = cleanLatexMathInHtml(data.result);
          try {
            await env.BOT_KV.put(`cache_${mode}_${videoId}`, JSON.stringify(data), {
              expirationTtl: 2592000,
            });
          } catch {}
        }
      }
      return data;
    }
  } catch {}
  return null;
}

async function setCachedAnalysis(env, videoId, mode, data) {
  if (!env || !env.BOT_KV) return;
  try {
    // کش کردن نتایج به مدت ۳۰ روز (۲,۵۹۲,۰۰۰ ثانیه)
    await env.BOT_KV.put(`cache_${mode}_${videoId}`, JSON.stringify(data), {
      expirationTtl: 2592000,
    });
  } catch {}
}

// ─── Keyboards ───────────────────────────────────────────────
function mainUserKeyboard(isAdmin, donateLink = null) {
  const rows = [
    [
      { text: "📖 راهنمای استفاده", callback_data: "user_help" },
      { text: "📊 وضعیت حساب من", callback_data: "my_status" },
    ],
    [
      { text: "💬 پشتیبانی و ارتباط با ادمین", callback_data: "user_support" },
    ],
  ];

  if (donateLink) {
    rows.push([{ text: "☕️ حمایت مالی / دونیت", url: donateLink }]);
  }

  if (isAdmin) {
    rows.push([{ text: "⚙️ ورود به پنل مدیریت", callback_data: "admin_panel" }]);
  }
  return { inline_keyboard: rows };
}

async function adminKeyboard(env, donateLink = null) {
  const wlOn = await isWhitelistEnabled(env);
  const regOpen = await isRegistrationOpen(env);
  const users = await getAllowedUsers(env);

  const rows = [
    [
      {
        text: wlOn ? "🛡 تایید عضویت: [روشن ✅]" : "🛡 تایید عضویت: [خاموش ❌]",
        callback_data: "admin_toggle_whitelist",
      },
      {
        text: regOpen ? "🚪 عضوگیری: [باز 🟢]" : "🚪 عضوگیری: [بسته 🔴]",
        callback_data: "admin_toggle_reg",
      },
    ],
    [
      { text: `👥 اعضا (${users.length} نفر)`, callback_data: "admin_list" },
      { text: "➕ افزودن", callback_data: "admin_add" },
      { text: "➖ حذف", callback_data: "admin_remove" },
    ],
    [
      { text: "📈 آمار مصرف کاربران", callback_data: "admin_stats" },
      { text: "📊 وضعیت کلیدهای جمنای", callback_data: "admin_quota" },
    ],
    [
      { text: "📢 ارسال پیام همگانی", callback_data: "admin_broadcast" },
      { text: "📋 لاگ‌های سیستم", callback_data: "admin_logs" },
    ],
    [
      {
        text: donateLink ? "☕️ لینک دونیت (فعال)" : "☕️ افزودن دونیت",
        callback_data: "admin_donate",
      },
      { text: "🔄 به‌روزرسانی بیو تلگرام", callback_data: "admin_sync_bot_profile" },
    ],
    [
      { text: "🧹 تبدیل فرمول‌های کش‌شده", callback_data: "admin_clean_cache" },
      { text: "🗑 حذف کل حافظه کش", callback_data: "admin_clear_cache" },
    ],
    [{ text: "🔙 بستن / منوی اصلی", callback_data: "main_menu" }],
  ];
  return { inline_keyboard: rows };
}

// ─── YouTube Helpers ─────────────────────────────────────────
function extractYouTubeUrl(text) {
  const patterns = [
    /(?:https?:\/\/)?(?:www\.|m\.)?youtube\.com\/watch\?v=([\w-]+)/i,
    /(?:https?:\/\/)?youtu\.be\/([\w-]+)/i,
    /(?:https?:\/\/)?(?:www\.)?youtube\.com\/shorts\/([\w-]+)/i,
    /(?:https?:\/\/)?(?:www\.)?youtube\.com\/embed\/([\w-]+)/i,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) {
      return { url: `https://www.youtube.com/watch?v=${m[1]}`, videoId: m[1] };
    }
  }
  return null;
}

async function getYouTubeMeta(videoId) {
  let title = "";
  let author = "";
  let thumbnail = "";
  let description = "";
  let duration = 0; // seconds

  // ۱. مرحله اول: دریافت متادیتا از طریق oEmbed رسمی یوتیوب
  try {
    const url = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`;
    const res = await fetch(url, { signal: AbortSignal.timeout(2500) });
    if (res.ok) {
      const data = await res.json();
      if (data && data.title) {
        title = (data.title || "").trim();
        author = (data.author_name || "").trim();
        thumbnail = (data.thumbnail_url || "").trim();
      }
    }
  } catch {}

  // ۲. مرحله دوم: دریافت مدت زمان، توضیحات و مشخصات تکمیلی از صفحه یوتیوب
  try {
    const pageUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const res = await fetch(pageUrl, {
      headers: {
        "User-Agent": "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      signal: AbortSignal.timeout(3500),
    });

    if (res.ok) {
      const html = await res.text();

      const mLength = html.match(/"lengthSeconds":"(\d+)"/) || html.match(/itemprop="duration"\s+content="PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?"/i);
      if (mLength) {
        if (mLength[1] && !mLength[0].includes("itemprop")) {
          duration = parseInt(mLength[1], 10);
        } else {
          const h = parseInt(mLength[1] || "0", 10);
          const m = parseInt(mLength[2] || "0", 10);
          const s = parseInt(mLength[3] || "0", 10);
          duration = h * 3600 + m * 60 + s;
        }
      }

      if (!title) {
        const mTitle =
          html.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i) ||
          html.match(/<meta\s+name=["']title["']\s+content=["']([^"']+)["']/i) ||
          html.match(/<title>([^<]+)<\/title>/i);
        if (mTitle) title = mTitle[1].replace(/ - YouTube$/i, "").trim();
      }

      const mDesc =
        html.match(/<meta\s+property=["']og:description["']\s+content=["']([^"']+)["']/i) ||
        html.match(/<meta\s+name=["']description["']\s+content=["']([^"']+)["']/i);
      if (mDesc) description = mDesc[1].trim();

      if (!author) {
        const mAuthor =
          html.match(/"ownerChannelName":"([^"]+)"/i) ||
          html.match(/"author":"([^"]+)"/i) ||
          html.match(/<link\s+itemprop=["']name["']\s+content=["']([^"']+)["']/i);
        if (mAuthor) author = mAuthor[1].trim();
      }

      if (!thumbnail) {
        const mThumb = html.match(/<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i);
        if (mThumb) thumbnail = mThumb[1].trim();
      }
    }
  } catch {}

  const decodeEntities = (str) =>
    (str || "")
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">");

  title = decodeEntities(title);
  author = decodeEntities(author);
  description = decodeEntities(description);

  if (title && title !== "YouTube" && !title.includes("404 Not Found")) {
    return {
      title,
      author,
      thumbnail,
      description,
      duration,
    };
  }

  return null;
}

// تبدیل ثانیه‌ها به فرمت خوانا (مثلاً 17:24 یا 1:05:30)
function formatDuration(sec) {
  if (!sec || isNaN(sec) || sec <= 0) return "";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${m}:${String(s).padStart(2, "0")}`;
}

// ─── Gemini LLM Caller با کیفیت بالا، سرعت فوق‌العاده و تایم‌اوت بهینه ───
async function executeGeminiRequest(prompt, env = null) {
  let lastError = "";
  const attempts = [];

  for (const model of GEMINI_MODELS) {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

    for (let i = 0; i < GEMINI_KEYS.length; i++) {
      const apiKey = GEMINI_KEYS[i];
      try {
        const res = await fetch(`${endpoint}?key=${apiKey}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: AbortSignal.timeout(5000), // مهلت حداکثر ۵ ثانیه
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
              temperature: 0.20, // دمای بسیار پایین برای تضمین واقع‌گرایی و قطع کامل توهم
              topP: 0.95,
              maxOutputTokens: 3500, // متن کامل بدون هیچ کم‌وکاستی
            },
            safetySettings: [
              { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
              { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
              { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
              { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
            ],
          }),
        });

        const data = await res.json();

        if (res.status === 429 || res.status === 503) {
          lastError = `${model}/کلید${i + 1}: ${res.status === 503 ? "ترافیک بالای سرور (503)" : "محدودیت نرخ (429)"}`;
          attempts.push(lastError);
          continue;
        }

        if (res.status === 404 || (data?.error?.message || "").includes("no longer available")) {
          lastError = `${model}: عدم دسترسی (404)`;
          attempts.push(lastError);
          break; // برو سراغ مدل بعدی
        }

        if (!res.ok) {
          lastError = `${model}/کلید${i + 1}: ${data?.error?.message || res.status}`;
          attempts.push(lastError);
          continue;
        }

        const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "";
        if (text.trim()) {
          if (env) {
            await recordKeyUsage(env, i + 1, model);
          }
          return {
            text: text.trim(),
            model: MODEL_LABELS[model] || model,
            keyIndex: i + 1,
          };
        }

        lastError = `${model}/کلید${i + 1}: پاسخ خالی`;
        attempts.push(lastError);
      } catch (err) {
        lastError = `${model}/کلید${i + 1}: ${err.message}`;
        attempts.push(lastError);
      }
    }
  }

  throw new Error(lastError || "خطا در اتصال به سرویس هوش مصنوعی");
}

async function callGemini(prompt, env = null, videoUrl = null) {
  // اگر ویدیو مجاز به ورودی ویدیویی مستقیم باشد، هوش مصنوعی کل فریم‌ها و صدای ویدیو را تحلیل می‌کند
  if (videoUrl) {
    const model = "gemini-3.5-flash-lite";
    for (let i = 0; i < GEMINI_KEYS.length; i++) {
      const apiKey = GEMINI_KEYS[i];
      try {
        const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
        const res = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: AbortSignal.timeout(8500),
          body: JSON.stringify({
            contents: [{
              parts: [
                { text: prompt },
                { fileData: { mimeType: "video/mp4", fileUri: videoUrl } }
              ]
            }],
            generationConfig: {
              temperature: 0.20,
              maxOutputTokens: 3500,
            },
            safetySettings: [
              { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
              { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
              { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
              { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
            ],
          }),
        });

        if (res.ok) {
          const data = await res.json();
          const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "";
          if (text.trim()) {
            if (env) await recordKeyUsage(env, i + 1, model);
            return {
              text: text.trim(),
              model: MODEL_LABELS[model] || model,
              keyIndex: i + 1,
            };
          }
        }

        // اگر خطای محدودیت حجم توکن ویدیو (429) بود، یعنی ویدیو بیش از حد طولانی است؛
        // بلافاصله از حلقه خارج می‌شویم تا سایر کلیدها وقت تلف نکنند و سریعاً به موتور متنی سوئیچ شود
        if (res.status === 429) {
          break;
        }
      } catch (err) {
        // ادامه تلاش یا فال‌بک به متن
      }
    }
  }

  // اجرای درخواست متنی سریع و سبک
  try {
    return await executeGeminiRequest(prompt, env);
  } catch (err) {
    if (env) {
      await addSystemLog(env, "ERROR", `شکست در تمامی کلیدها و مدل‌های جمنای: ${err.message}`, {
        videoUrl,
      });
    }
    throw err;
  }
}

// تبدیل ثانیه‌ها و دقیقه‌ها به عدد ثانیه جهت ساخت لینک
function parseTimestampSeconds(str) {
  const parts = str.split(":").map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return 0;
}

// لینک‌دار کردن هوشمند تمام تایم‌استمپ‌های ویدیو به ثانیه دقیق در یوتیوب
function linkTimestamps(text, videoId) {
  if (!videoId) return text;
  return text.replace(
    /\[(\d{1,2}:\d{2}(?::\d{2})?)(?:\s*\([^)]+\)|\s*[-–—]\s*(\d{1,2}:\d{2}(?::\d{2})?))?\]/g,
    (match, start, end) => {
      const s = parseTimestampSeconds(start);
      if (end) {
        return `<a href="https://youtu.be/${videoId}?t=${s}">[${start} - ${end}]</a>`;
      }
      return `<a href="https://youtu.be/${videoId}?t=${s}">[${start}]</a>`;
    }
  );
}

// ─── تبدیل و تمیزسازی فرمول‌های ریاضی و کدهای LaTeX به نمادهای یونیکد تلگرام ──
function extractBalancedBrace(str, startIndex) {
  if (str[startIndex] !== '{') return null;
  let depth = 0;
  for (let i = startIndex; i < str.length; i++) {
    if (str[i] === '{') depth++;
    else if (str[i] === '}') {
      depth--;
      if (depth === 0) return { content: str.substring(startIndex + 1, i), endIndex: i };
    }
  }
  return null;
}

function replaceFractions(s) {
  let idx = s.indexOf('\\frac');
  let safety = 0;
  while (idx !== -1 && safety++ < 40) {
    let cursor = idx + 5;
    while (cursor < s.length && /\s/.test(s[cursor])) cursor++;
    const num = extractBalancedBrace(s, cursor);
    if (!num) break;
    cursor = num.endIndex + 1;
    while (cursor < s.length && /\s/.test(s[cursor])) cursor++;
    const den = extractBalancedBrace(s, cursor);
    if (!den) break;
    let numStr = replaceFractions(num.content).trim();
    let denStr = replaceFractions(den.content).trim();
    const wrapPart = p => (/^[a-zA-Z0-9α-ωΑ-Ω]+$/.test(p) ? p : `(${p})`);
    const replacement = `${wrapPart(numStr)} / ${wrapPart(denStr)}`;
    s = s.substring(0, idx) + replacement + s.substring(den.endIndex + 1);
    idx = s.indexOf('\\frac');
  }
  return s;
}

function convertSuperscript(str) {
  const superMap = {
    "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵",
    "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹", "+": "⁺", "-": "⁻",
    "=": "⁼", "(": "⁽", ")": "⁾", "n": "ⁿ", "i": "ⁱ", "x": "ˣ",
    "y": "ʸ", "a": "ᵃ", "b": "ᵇ", "c": "ᶜ", "d": "ᵈ", "e": "ᵉ",
    "f": "ᶠ", "g": "ᵍ", "h": "ʰ", "j": "ʲ", "k": "ᵏ", "l": "ˡ",
    "m": "ᵐ", "o": "ᵒ", "p": "ᵖ", "r": "ʳ", "s": "ˢ", "t": "ᵗ",
    "u": "ᵘ", "v": "ᵛ", "w": "ʷ", "z": "ᶻ"
  };
  return str.split("").map(c => superMap[c] || c).join("");
}

function convertSubscript(str) {
  const subMap = {
    "0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄", "5": "₅",
    "6": "₆", "7": "₇", "8": "₈", "9": "₉", "+": "₊", "-": "₋",
    "=": "₌", "(": "₍", ")": "₎", "a": "ₐ", "e": "ₑ", "h": "ₕ",
    "i": "ᵢ", "j": "ⱼ", "k": "ₖ", "l": "ₗ", "m": "ₘ", "n": "ₙ",
    "o": "ₒ", "p": "ₚ", "r": "ᵣ", "s": "ₛ", "t": "ₜ", "u": "ᵤ",
    "v": "ᵥ", "x": "ₓ"
  };
  return str.split("").map(c => subMap[c] || c).join("");
}

function latexToUnicode(tex) {
  if (!tex) return "";
  let s = tex;
  s = s.replace(/^\$\$|\$\$$|^\\\[|\\\]$|^\\\(|\\\)$|^\$|\$$/g, "").trim();

  // تبدیل کسرها با در نظر گرفتن براکت‌های تودرتو
  s = replaceFractions(s);

  // پاکسازی دستورات متنی
  s = s.replace(/\\(?:text|mathrm|mathbf|mathit|textbf|textit)\{([^}]+)\}/g, "$1");

  // حروف یونانی
  const greek = {
    alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε",
    zeta: "ζ", eta: "η", theta: "θ", iota: "ι", kappa: "κ",
    lambda: "λ", mu: "μ", nu: "ν", xi: "ξ", pi: "π",
    rho: "ρ", sigma: "σ", tau: "τ", upsilon: "υ", phi: "φ",
    chi: "χ", psi: "ψ", omega: "ω",
    Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ",
    Xi: "Ξ", Pi: "Π", Sigma: "Σ", Upsilon: "Υ",
    Phi: "Φ", Psi: "Ψ", Omega: "Ω"
  };
  for (const [k, v] of Object.entries(greek)) {
    s = s.replace(new RegExp("\\\\" + k + "(?![a-zA-Z])", "g"), v);
  }

  // نمادهای ریاضی
  const syms = {
    times: "×", cdot: "·", div: "÷", pm: "±", mp: "∓",
    leq: "≤", le: "≤", geq: "≥", ge: "≥", neq: "≠", ne: "≠",
    approx: "≈", equiv: "≡", infty: "∞", propto: "∝",
    forall: "∀", exists: "∃", in: "∈", notin: "∉",
    subset: "⊂", subseteq: "⊆", cup: "∪", cap: "∩",
    rightarrow: "→", to: "→", leftarrow: "←",
    Rightarrow: "⇒", Leftarrow: "⇐", Leftrightarrow: "⇔", iff: "⇔",
    partial: "∂", nabla: "∇", sum: "∑", prod: "∏", int: "∫",
    oint: "∮", degree: "°", circ: "°"
  };
  for (const [k, v] of Object.entries(syms)) {
    s = s.replace(new RegExp("\\\\" + k + "(?![a-zA-Z])", "g"), v);
  }

  // رادیکال‌ها
  s = s.replace(/\\sqrt\[([^\]]+)\]\{([^}]+)\}/g, "($1)√($2)");
  s = s.replace(/\\sqrt\{([^}]+)\}/g, "√($1)");

  // توان‌ها
  s = s.replace(/\^\{([^{}]+)\}/g, (_, p) => {
    p = p.replace(/\^([0-9a-zA-Z+-])/g, (__, c) => convertSuperscript(c));
    return convertSuperscript(p);
  });
  s = s.replace(/\^([0-9a-zA-Z+-])/g, (_, c) => convertSuperscript(c));

  // اندیس‌ها
  s = s.replace(/_\{([^{}]+)\}/g, (_, p) => convertSubscript(p));
  s = s.replace(/_([0-9a-zA-Z+-])/g, (_, c) => convertSubscript(c));

  // پاکسازی براکت‌ها و بک‌اسلش‌های باقی‌مانده
  s = s.replace(/[{}\\]/g, " ");
  s = s.replace(/\s{2,}/g, " ").trim();
  return s;
}

// کاراکتر کنترلی جهت‌بندی چپ به راست (Left-to-Right Mark) برای حفظ ساختار فرمول‌ها در متن فارسی
const LRM = "‎";

function cleanLatexMath(text) {
  if (!text) return "";
  let res = text;

  // 1. بلوک‌های ریاضی دیسپلی داخل کوت مارک‌داون با جهت‌بندی چپ‌چین LTR
  res = res.replace(/\\begin\{(?:equation|align|gather)\*?\}([\s\S]+?)\\end\{(?:equation|align|gather)\*?\}/g, (_, math) => {
    return `\n> \`${LRM}${latexToUnicode(math)}${LRM}\`\n`;
  });
  res = res.replace(/\$\$([\s\S]+?)\$\$/g, (_, math) => {
    return `\n> \`${LRM}${latexToUnicode(math)}${LRM}\`\n`;
  });
  res = res.replace(/\\\[([\s\S]+?)\\\]/g, (_, math) => {
    return `\n> \`${LRM}${latexToUnicode(math)}${LRM}\`\n`;
  });

  // 2. فرمول‌های درون‌خطی با ایزولاسیون جهت‌بندی LRM برای جلوگیری از برعکس شدن پرانتزها در متن فارسی
  res = res.replace(/\\\(([\s\S]+?)\\\)/g, (_, math) => {
    return `${LRM}\`${LRM}${latexToUnicode(math)}${LRM}\`${LRM}`;
  });
  res = res.replace(/\$([^\$\n]+?)\$/g, (match, math) => {
    if (/[؀-ۿ]/.test(math)) {
      return match;
    }
    return `${LRM}\`${LRM}${latexToUnicode(math)}${LRM}\`${LRM}`;
  });

  // 3. در صورت وجود دستورات لاتکس رهاشده بدون دالر
  if (/\\(?:frac|sqrt|alpha|beta|gamma|delta|theta|lambda|pi|sigma|omega|times|pm|approx|int|sum)\b/.test(res)) {
    res = res.replace(/\\(?:frac|sqrt|alpha|beta|gamma|delta|theta|lambda|pi|sigma|omega|times|pm|approx|int|sum)[^$\n]*/g, m => {
      return `${LRM}\`${LRM}${latexToUnicode(m)}${LRM}\`${LRM}`;
    });
  }

  return res;
}

// بررسی وجود کدهای لاتکس در متن
function hasLatexMath(text) {
  if (!text) return false;
  return /\$\$|\\\[|\\\(|\$[^\$\n]+?\$|\\begin\{(?:equation|align|gather)\}|\\(?:frac|sqrt|alpha|beta|gamma|delta|theta|lambda|pi|sigma|omega|times|pm|approx|int|sum)\b/.test(text);
}

// پاکسازی و تبدیل کدهای لاتکس در متونی که از قبل در دیتابیس یا کش به فرمت HTML ذخیره شده‌اند
function cleanLatexMathInHtml(html) {
  if (!html) return "";
  let res = html;

  // اگر فرمول از قبل داخل تگ <code> یا `...` بوده، محتوای درون آن را به یونیکد تبدیل می‌کنیم
  res = res.replace(/<code>([^<]*?(?:\\|\$)[^<]*?)<\/code>/g, (_, inner) => {
    return `${LRM}<code>${LRM}` + escapeHtml(latexToUnicode(inner)) + `${LRM}</code>${LRM}`;
  });
  res = res.replace(/`([^`]*?(?:\\|\$)[^`]*?)`/g, (_, inner) => {
    return `${LRM}<code>${LRM}` + escapeHtml(latexToUnicode(inner)) + `${LRM}</code>${LRM}`;
  });

  // 1. بلوک‌های ریاضی دیسپلی داخل کوت تلگرام با چپ‌چین LTR
  res = res.replace(/\\begin\{(?:equation|align|gather)\*?\}([\s\S]+?)\\end\{(?:equation|align|gather)\*?\}/g, (_, math) => {
    return `\n<blockquote>${LRM}<code>${LRM}` + escapeHtml(latexToUnicode(math)) + `${LRM}</code></blockquote>\n`;
  });
  res = res.replace(/\$\$([\s\S]+?)\$\$/g, (_, math) => {
    return `\n<blockquote>${LRM}<code>${LRM}` + escapeHtml(latexToUnicode(math)) + `${LRM}</code></blockquote>\n`;
  });
  res = res.replace(/\\\[([\s\S]+?)\\\]/g, (_, math) => {
    return `\n<blockquote>${LRM}<code>${LRM}` + escapeHtml(latexToUnicode(math)) + `${LRM}</code></blockquote>\n`;
  });

  // 2. فرمول‌های درون‌خطی با ایزولاسیون LRM
  res = res.replace(/\\\(([\s\S]+?)\\\)/g, (_, math) => {
    return `${LRM}<code>${LRM}` + escapeHtml(latexToUnicode(math)) + `${LRM}</code>${LRM}`;
  });
  res = res.replace(/\$([^\$\n]+?)\$/g, (match, math) => {
    if (/[؀-ۿ]/.test(math)) {
      return match;
    }
    return `${LRM}<code>${LRM}` + escapeHtml(latexToUnicode(math)) + `${LRM}</code>${LRM}`;
  });

  // 3. در صورت وجود دستورات لاتکس رهاشده بدون دالر
  if (/\\(?:frac|sqrt|alpha|beta|gamma|delta|theta|lambda|pi|sigma|omega|times|pm|approx|int|sum)\b/.test(res)) {
    res = res.replace(/\\(?:frac|sqrt|alpha|beta|gamma|delta|theta|lambda|pi|sigma|omega|times|pm|approx|int|sum)[^$\n<]*/g, m => {
      return `${LRM}<code>${LRM}` + escapeHtml(latexToUnicode(m)) + `${LRM}</code>${LRM}`;
    });
  }

  // حذف تگ‌های تودرتو احتمالی <code><code>
  res = res.replace(/<code>\s*<code>/g, "<code>").replace(/<\/code>\s*<\/code>/g, "</code>");

  return res;
}

// ─── فرمت‌بندی پیشرفته و تمیز به سبک تلگرام پریمیوم ──────────
function formatTelegramHtml(rawText, videoId = null) {
  if (!rawText) return "";

  // تبدیل کدهای خام لاتکس (LaTeX) به ساختار تمیز یونیکد سازگار با تلگرام
  rawText = cleanLatexMath(rawText);

  let lines = rawText.split("\n");
  let formattedLines = [];

  for (let rawLine of lines) {
    let line = rawLine.trim();

    // حذف خط‌های جداکننده افقی مارک‌داون (مثل --- یا *** یا ___ )
    if (/^[-*_]{2,}$/.test(line)) {
      continue;
    }

    // تبدیل هدرهای مارک‌داون (### یا ## یا #)
    if (/^#{1,6}\s*(.+)$/.test(line)) {
      const match = line.match(/^#{1,6}\s*(.+)$/);
      let heading = match[1].replace(/\*\*/g, "").replace(/\*/g, "").trim();
      formattedLines.push(`\n<b>${escapeHtml(heading)}</b>`);
      continue;
    }

    // تبدیل بالت‌پوینت‌های مارک‌داون (مانند: * یا - یا + با هر تعداد فاصله)
    if (/^[*•\-+]\s*(.+)$/.test(line)) {
      const match = line.match(/^[*•\-+]\s*(.+)$/);
      let content = match[1].trim();
      content = convertInlineMarkdown(content);
      formattedLines.push(`▫️ ${content}`);
      continue;
    }

    // شماره‌گذاری‌ها (مثلاً 1. یا ۱.)
    if (/^(\d+|[۰-۹]+)[.\-)]\s*(.+)$/.test(line)) {
      const match = line.match(/^(\d+|[۰-۹]+)[.\-)]\s*(.+)$/);
      let num = match[1];
      let content = convertInlineMarkdown(match[2].trim());
      formattedLines.push(`<b>${num}.</b> ${content}`);
      continue;
    }

    // خط خالی
    if (!line) {
      formattedLines.push("");
      continue;
    }

    // خط معمولی
    formattedLines.push(convertInlineMarkdown(line));
  }

  let text = formattedLines.join("\n").replace(/\n{3,}/g, "\n\n").trim();

  // قرار دادن بخش استدلال (Chain of Thought) در کادر شیک و تاشو blockquote expandable تلگرام
  text = text.replace(
    /(🧠[^\n]+Chain of Thought[^\n]*\n)([\s\S]*?)(?=\n\n[🎯📝🔍👥💡]|\n\n<b>|$)/i,
    (match, header, body) => `<blockquote expandable>${header.trim()}\n${body.trim()}</blockquote>\n\n`
  );

  // تبدیل نقل‌قول‌های مارک‌داون (> متن) به تگ مدرن <blockquote> تلگرام (با تنظیم خودکار جهت‌چینی چپ به راست برای فرمول‌ها)
  text = text.replace(/(?:^|\n)&gt;\s*(.+)/g, (_, body) => {
    const isFormulaOrLtr = /<code>|[‎a-zA-Z=±×÷√∑∫]/.test(body);
    return `\n<blockquote>${isFormulaOrLtr ? LRM : ""}${body}</blockquote>`;
  });

  // کلیک‌پذیر کردن تایم‌استمپ‌ها به ثانیه مورد نظر در یوتیوب
  if (videoId) {
    text = linkTimestamps(text, videoId);
  }

  return text.replace(/\n{3,}/g, "\n\n").trim();
}

// فرار دادن کاراکترهای خاص HTML برای جلوگیری از خطای تلگرام
function escapeHtml(text) {
  if (!text) return "";
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// تبدیل کلمات بولد، ایتالیک و کد
function convertInlineMarkdown(text) {
  let safe = escapeHtml(text);

  // تبدیل **متن** به <b>متن</b>
  safe = safe.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");

  // تبدیل __متن__ به <u>متن</u> (زیرخط دار)
  safe = safe.replace(/__(.+?)__/g, "<u>$1</u>");

  // تبدیل *متن* یا _متن_ به <i>متن</i>
  safe = safe.replace(/(?<!\*)\*([^*]+?)\*(?!\*)/g, "<i>$1</i>");
  safe = safe.replace(/(?<!_)_([^_]+?)_(?!_)/g, "<i>$1</i>");

  // تبدیل `کد` به <code>کد</code>
  safe = safe.replace(/`([^`]+)`/g, "<code>$1</code>");

  // پاک کردن ستاره‌های جا مانده و سرگردان
  safe = safe.replace(/\*/g, "");

  return safe;
}

// تقسیم هوشمند متن‌های طولانی تلگرام بدون تکه‌تکه شدن کلمات یا پاراگراف‌ها
function splitTextChunks(text, maxLen = 3900) {
  if (!text || text.length <= maxLen) return [text || ""];
  const chunks = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    let splitIdx = remaining.lastIndexOf("\n\n", maxLen);
    if (splitIdx === -1 || splitIdx < maxLen * 0.4) {
      splitIdx = remaining.lastIndexOf("\n", maxLen);
    }
    if (splitIdx === -1 || splitIdx < maxLen * 0.4) {
      splitIdx = remaining.lastIndexOf(". ", maxLen);
      if (splitIdx !== -1) splitIdx += 1;
    }
    if (splitIdx === -1 || splitIdx < maxLen * 0.4) {
      splitIdx = maxLen;
    }
    chunks.push(remaining.substring(0, splitIdx).trim());
    remaining = remaining.substring(splitIdx).trim();
  }
  if (remaining.length > 0) {
    chunks.push(remaining);
  }
  return chunks;
}

// ─── تحلیل ویدیو یوتیوب (سه حالت: خلاصه سریع، تحلیل جامع، شرح ویدیو) ──
async function analyzeYouTube(videoId, ytUrl, mode = "full", env = null) {
  // ۱. بررسی حافظه موقت (Cache) در KV - در صورت وجود، بدون مصرف توکن و فوری تحویل داده می‌شود
  const cached = await getCachedAnalysis(env, videoId, mode);
  if (cached && cached.result) {
    let finalResult = cached.result;
    if (hasLatexMath(finalResult)) {
      finalResult = cleanLatexMathInHtml(finalResult);
    }
    return {
      result: finalResult,
      meta: cached.meta,
      modelName: cached.modelName,
      fromCache: true,
    };
  }

  const meta = await getYouTubeMeta(videoId);

  if (!meta || !meta.title) {
    throw new Error(
      "اطلاعات و عنوان این ویدیو از سرورهای یوتیوب قابل دریافت نیست (احتمالاً ویدیو خصوصی، حذف‌شده یا دسترسی به آن محدود است). " +
      "جهت حفظ دقت و جلوگیری از خطای هوش مصنوعی، امکان تحلیل این ویدیو وجود ندارد."
    );
  }

  const durationSec = meta.duration || 0;
  const durationFormatted = durationSec > 0 ? formatDuration(durationSec) : "";
  const durationMinutes = durationSec > 0 ? Math.round(durationSec / 60) : 0;

  let prompt;
  if (mode === "quick") {
    prompt = `شما یک دستیار هوشمند و تیزبین محتوای یوتیوب هستید.
مشخصات ویدیو:
عنوان: "${meta.title}"
سازنده / کانال: "${meta.author || "نامشخص"}"
${durationSec > 0 ? `مدت زمان کل ویدیو: ${durationFormatted} (${durationMinutes} دقیقه)` : ""}
${meta.description ? `توضیحات سازنده: "${meta.description.substring(0, 400)}"` : ""}
آدرس: ${ytUrl}

وظیفه شما: ارائه یک «خلاصه کوتاه، سریع، تمیز و بدون حاشیه» از این ویدیو به زبان فارسی.
هدف: کاربر می‌خواهد سریعاً و در عرض چند ثانیه متوجه شود:
۱. این محتوا اصلاً چیه؟
۲. در این ویدیو توش چیا میگه و چه اتفاقاتی می‌افتد؟

دستورالعمل‌ها و قوانین حیاتی (ضد توهم و واقع‌گرایی مطلق):
۱. تحلیل باید ۱۰۰٪ بر اساس مشخصات واقعی، عنوان و توضیحات این اثر باشد.
۲. اکیداً ممنوع: هرگز محتوای ویدیوهای خارجی، میم‌ها، کلیپ‌های سوررئال/دارک، هنر اینترنتی یا ویدیوهای عجیب با عروسک/ماسک (مانند آثار Shaye Saint John، Blank Room Soup، کریپی‌پاستاها، موزیک‌ویدیوها، انیمیشن‌ها) را به مسائل سیاسی، اقتصادی، پادکست‌های اجتماعی یا اخبار ایران نسبت ندهید!
۳. اگر ویدیو یک اثر سوررئال، میم اینترنتی، کلیپ وحشت/دارک، انیمیشن عجیب، بی‌کلام یا هنر تجربی است، با صراحت دقیقاً همان ماهیت واقعی را بیان کنید و هرگز سناریوی خیالی نسازید.
۴. به هیچ عنوان به کاربر توصیه، پند یا نصیحت نکنید (هیچ پیشنهادی برای تماشا یا عدم تماشا ندهید).
۵. کوتاه، فشرده و تر و تمیز باشد (بدون مقدمه‌چینی و گزافه‌گویی).
۶. از هیچ‌گونه علامت هدر مارک‌داون مانند ### یا ## یا خطوط --- استفاده نکنید.
۷. هر بخش را با ایموجی متناسب و متن بولد آغاز کنید.
۸. قانون نگارش فرمول‌ها و محاسبات ریاضی (سازگاری با تلگرام و جهت‌چینی راست به چپ):
- اکیداً از درج کدهای خام LaTeX (مانند $ یا $$ یا دستورات \\frac و \\sqrt) خودداری کنید!
- فرمول‌ها و معادلات مهم را در یک سطر جداگانه به صورت نقل‌قول با علامت > و درون بک‌تیک بنویسید (مانند: > \`E = mc²\` یا > \`x = (-b ± √(b² - 4ac)) / 2a\`) تا در تلگرام به صورت کارت کوت (Quote) کاملاً چپ‌چین (LTR) و شکیل نمایش داده شوند.
- فرمول‌های درون‌متنی را حتماً درون بک‌تیک بنویسید (مانند \`a = v / t\`) تا با کلمات فارسی ترکیب نشده و پرانتزها برعکس نشوند.

ساختار الزامی خروجی:
📌 موضوع و ماهیت ویدیو:
(یک جمله صریح و شفاف که این ویدیو دقیقاً چیه)

📝 خلاصه محتوا و ماجرا:
(چند خط شسته و رفته درباره اینکه در ویدیو توش چیا میگه و چه اتفاقاتی می‌افتد)

💡 کلام آخر و پیام محوری:
(یک جمله پایانی درباره لب کلام یا جایگاه اثر)`;
  } else if (mode === "desc") {
    let timelineRule = "";
    if (durationSec > 0) {
      timelineRule = `
مدت زمان کامل این اثر: ${durationFormatted} (حدود ${durationMinutes} دقیقه) است.

قانون بسیار حیاتی و الزامی توزیع زمانی (پوشش کامل از ابتدا تا انتها):
۱. شما موظف هستید رویدادها و مباحث ویدیو را در سرتاسر کل طول اثر (از نقطه شروع [00:00] تا ثانیه‌های پایانی نزدیک به [${durationFormatted}]) به صورت کاملاً متوازن و پیوسته روایت کنید.
۲. اکیداً نباید فقط به ۱۰ یا ۱۵ دقیقه ابتدایی اکتفا کنید یا ویدیو را در میانه کار رها کنید!
۳. بخش‌های ویدیو را در طول کل زمان اثر پخش کنید: رخدادهای ابتدا، یک‌چهارم اول، نیمه ویدیو، سه‌چهارم ویدیو و دقایق پایانی اثر را به ترتیب بنویسید تا مخاطب رویدادهای تمام ${durationMinutes} دقیقه را به صورت کامل و مستند درک کند.`;
    }

    prompt = `شما یک دستیار هوشمند، دقیق و تیزبین هستید.
مشخصات ویدیو:
عنوان: "${meta.title}"
سازنده / کانال: "${meta.author || "نامشخص"}"
${meta.description ? `توضیحات سازنده: "${meta.description.substring(0, 400)}"` : ""}
آدرس ویدیو: https://www.youtube.com/watch?v=${videoId}
${timelineRule}

وظیفه شما: ارائه «شرح و روایت دقیق رویدادهای ویدیو» به زبان فارسی بر اساس رخدادهای واقعی داخل ویدیو.

سبک نگارش و قالب الزامی (دقیقاً مشابه این الگو باشد):
- یک جمله کوتاه معرفی در ابتدا (شامل عنوان، کانال و حال‌وهوای کلی اثر).
- خط بعد: "در ادامه خلاصه و شرح بخش‌های مهم این ویدیو آورده شده است:"
- سپس هر بخش کلیدی در یک پاراگراف روان و داستانی با این فرمت:
**عنوان توصیفی بخش:** شرح اتفاقات، کنش‌ها، دیالوگ‌ها و رویدادها همراه با درج تایم‌استمپ دقیق به صورت [MM:SS] در پایان هر رویداد، تغییر صحنه یا دیالوگ.
(نکته مهم: به جای نوشتن کلمه کلی «عنوان بخش»، یک عنوان واقعی، جذاب و مرتبط با ماجرا بنویس؛ مانند «شروع و ماجرای عروسک‌ها:» یا «کشف عروسک سوخته:» یا «پایان‌بندی تاریک و تکرار شوم:»)

قوانین حیاتی (ضد توهم و واقع‌گرایی مطلق):
۱. تمام گزارش باید ۱۰۰٪ عینی، مستند و بر اساس رخدادها، دیالوگ‌ها و تصاویر واقعی ویدیو باشد (صفر درصد توهم یا سناریوی خیالی).
۲. هرگز محتوای ویدیوهای خارجی، میم‌ها، کلیپ‌های سوررئال/هنری، آثار عروسکی یا کریپی‌پاستاها را به مسائل سیاسی، اقتصادی یا اخبار ایران نسبت ندهید!
۳. به هیچ عنوان به کاربر توصیه یا پند اخلاقی ندهید.
۴. تایم‌استمپ‌ها حتماً درون قلاب [MM:SS] نوشته شوند تا به صورت خودکار قابل کلیک باشند.
۵. از علامت‌های هدر مارک‌داون مانند ### یا خطوط افقی --- استفاده نکنید.
۶. قانون نگارش فرمول‌ها و محاسبات ریاضی (سازگاری با تلگرام و جهت‌چینی راست به چپ): هرگز از کدهای خام LaTeX استفاده نکنید. فرمول‌های مهم را در یک سطر جداگانه با علامت > و درون بک‌تیک بنویسید (مانند: > \`E = mc²\`) تا به صورت کارت چپ‌چین (LTR) نمایش داده شوند، و فرمول‌های درون‌متنی را داخل بک‌تیک بگذارید (مانند \`x²\`).`;
  } else {
    // mode === "full"
    let timelineRule = "";
    if (durationSec > 0) {
      timelineRule = `
مدت زمان کامل این اثر: ${durationFormatted} (${durationMinutes} دقیقه) است.
دستورالعمل پوشش زمانی: در بخش «شرح کامل مباحث و اتفاقات ویدیو»، مباحث و رویدادها را در سرتاسر کل طول اثر (از شروع تا نقطه پایانی نزدیک به ${durationFormatted}) پوشش دهید و صرفاً به دقایق آغازین محدود نشوید.`;
    }

    prompt = `شما یک تحلیلگر دقیق، مسلط و واقع‌گرای محتوای یوتیوب هستید.
مشخصات ویدیو:
عنوان: "${meta.title}"
سازنده / کانال: "${meta.author || "نامشخص"}"
${meta.description ? `توضیحات سازنده: "${meta.description.substring(0, 400)}"` : ""}
آدرس: ${ytUrl}
${timelineRule}

وظیفه شما: ارائه یک تحلیل کامل، جامع و شیوا از این ویدیو به زبان فارسی.

دستورالعمل‌ها و قوانین حیاتی (ضد توهم و واقع‌گرایی مطلق):
۱. فقط کامل، مستند و شیوا بگویید ویدیو چیه، توش چیا میگه و چه اتفاقاتی می‌افتد.
۲. اکیداً ممنوع: هرگز محتوای ویدیوهای خارجی، میم‌ها، کلیپ‌های سوررئال/دارک، هنر اینترنتی یا ویدیوهای عجیب با عروسک/ماسک (مانند آثار Shaye Saint John، Blank Room Soup، کریپی‌پاستاها، موزیک‌ویدیوها، انیمیشن‌ها) را به مسائل سیاسی، اقتصادی، پادکست‌های اجتماعی یا اخبار ایران نسبت ندهید!
۳. اگر ویدیو بی‌کلام، وحشت دیجیتال، طنز سیاه، کلیپ کوتاه یا هنر تجربی است، با صراحت دقیقاً همان ماهیت واقعی را بیان کنید و هرگز سناریوی خیالی نسازید.
۴. به هیچ عنوان به کاربر توصیه، پند یا نصیحت نکنید (هیچ پیشنهادی برای تماشا یا عدم تماشا ندهید).
۵. فرآیند استدلال گام‌به‌گام (Chain of Thought) خود را در ابتدای پاسخ منعکس کنید.
۶. از هیچ‌گونه علامت هدر مارک‌داون مانند ### یا ## یا خطوط --- استفاده نکنید.
۷. هر بخش را با ایموجی متناسب و متن بولد آغاز کنید.
8. بالت‌پوینت‌ها را حتماً در یک سطر جدید با علامت ▫️ بنویسید.
۹. زبان تحلیل شیوا، روان و واقع‌بینانه باشد.
۱۰. قانون نگارش فرمول‌ها و محاسبات ریاضی (سازگاری با تلگرام و جهت‌چینی راست به چپ):
- تلگرام از کدهای خام LaTeX (مانند $ یا $$ یا دستورات \\frac و \\sqrt) پشتیبانی نمی‌کند. اکیداً از درج کدهای خام LaTeX خودداری کنید!
- تمام معادلات و فرمول‌های مهم یا چندبخشی را در یک سطر جداگانه به صورت نقل‌قول با علامت > و درون بک‌تیک بنویسید (مانند: > \`x = (-b ± √(b² - 4ac)) / 2a\` یا > \`E = mc²\`) تا در تلگرام در یک کادر کوت (Quote) شکیل و کاملاً چپ‌چین (LTR) قرار گیرند و هیچ پرانتز یا علامتی به خاطر متن فارسی برعکس نشود.
- فرمول‌های درون‌متنی را حتماً درون بک‌تیک بنویسید (مانند \`a = v / t\` یا \`x²\`).

ساختار الزامی خروجی:

🧠 استدلال و تحلیل گام‌به‌گام (Chain of Thought):
▫️ تشخیص ماهیت و ژانر: (قالب و سبک دقیق اثر؛ آموزشی، موزیک‌ویدیو، سوررئال/هنر تجربی، میم، گیمینگ، ولاگ و...)
▫️ راستی‌آزمایی محتوا: (بررسی فکت‌های موثق بر اساس عنوان و شناسنامه اثر، پرهیز از فرضیات نامربوط)
▫️ نگاه واقع‌بینانه: (بررسی محتوا بدون اغراق یا تعارف)

🎯 موضوع و محور اصلی:
(ویدیو کلاً چیه و چه موضوعی را دنبال می‌کند در ۱ یا ۲ جمله)

📝 شرح کامل مباحث و اتفاقات ویدیو:
(توش چیا میگه؟ تمام اتفاقات، دیالوگ‌ها یا نماهای اثر به ترتیب، کامل و روان)

🔍 نکات و جزئیات مهم مطرح‌شده:
(نکات بارز اثر متناسب با سبک آن با علامت ▫️)

👥 مخاطبان و جایگاه اثر:
(این اثر برای چه افرادی ساخته شده و چه جایگاهی دارد با علامت ▫️)`;
  }

  // برای ویدیوهای استاندارد یوتیوب (تا ۵۰ دقیقه) در حالت شرح، هوش مصنوعی مستقیماً فریم‌ها و صدای ویدیو را ثانیه‌به‌ثانیه شرح می‌دهد
  // برای ویدیوهای فوق‌العاده طولانی (بالای ۵۰ دقیقه مانند فیلم‌ها و سریال‌های چندساعته) از موتور متنی استفاده می‌شود تا سقف توکن رد نشود
  const isEligibleForVideo = !meta.duration || meta.duration <= 3000;
  const videoDirectUrl = (mode === "desc" && isEligibleForVideo) ? `https://www.youtube.com/watch?v=${videoId}` : null;
  const { text: rawText, model: modelName } = await callGemini(prompt, env, videoDirectUrl);

  const formattedResult = formatTelegramHtml(rawText, videoId);

  // ۲. ذخیره نتیجه کامل در KV Cache برای استفاده‌های بعدی (بدون مصرف مجدد توکن)
  await setCachedAnalysis(env, videoId, mode, {
    result: formattedResult,
    meta,
    modelName,
  });

  return { result: formattedResult, meta, modelName, fromCache: false };
}

// ─── Help Text ───────────────────────────────────────────────
function getHelpText(isAdmin) {
  let text =
    `📖 <b>راهنمای جامع استفاده از ربات تحلیلگر یوتیوب</b>\n\n` +
    `این ربات با بهره‌گیری از هوش مصنوعی چندوجهی Google Gemini ویدیوهای یوتیوب را به طور هوشمند تحلیل و پردازش می‌کند.\n\n` +
    `⚡️ <b>معرفی حالات سه‌گانه تحلیل:</b>\n\n` +
    `۱️⃣ <b>خلاصه کوتاه و سریع (Quick):</b>\n` +
    `در عرض چند ثانیه به شما می‌گوید این محتوا کلاً چیه، توش چیا میگه و لب کلامش چیه (ایده‌آل برای تصمیم‌گیری سریع جهت تماشا یا عدم تماشا).\n\n` +
    `۲️⃣ <b>تحلیل کامل و جامع (Full):</b>\n` +
    `کالبدشکافی ساختاری و استخراج دقیق تمام مباحث ویدیو به همراه جعبه تفکر عمیق مدل (Chain of Thought) در کادر تاشونده تلگرام.\n\n` +
    `۳️⃣ <b>شرح صحنه‌به‌صحنه (Description):</b>\n` +
    `روایت داستانی و اتفاقات ویدیو در طول کل تایم‌لاین با تایم‌استمپ‌های دقیق کلیک‌پذیر [MM:SS] که با لمس هر کدام، مستقیماً به همان ثانیه ویدیو در یوتیوب منتقل می‌شوید.\n\n` +
    `⏱ <b>راهنمای مدت زمان ویدیوها:</b>\n` +
    `• <b>ویدیوهای تا ۵۰ دقیقه:</b> بررسی فریم‌به‌فریم، دیداری و صوتی با نهایت دقت ثانیه‌ای.\n` +
    `• <b>ویدیوهای بالای ۵۰ دقیقه:</b> پردازش مبتنی بر فراداده و متن توضیحات.\n\n` +
    `🔹 <b>نمونه لینک‌های مجاز:</b>\n` +
    `• <code>https://youtube.com/watch?v=...</code>\n` +
    `• <code>https://youtu.be/...</code>\n` +
    `• <code>https://youtube.com/shorts/...</code>\n\n` +
    `💬 در صورت وجود هرگونه سوال، پیشنهاد یا گزارش مشکل، می‌توانید از دکمه «پشتیبانی و ارتباط با ادمین» استفاده کنید.`;

  if (isAdmin) {
    text += `\n\n👑 <b>دستورات اختصاصی مدیریت:</b>\n` +
      `• <code>/admin</code> - ورود به پنل مدیریت\n` +
      `• <code>/status</code> - آمار لحظه‌ای اعضا و کلیدها\n` +
      `• <code>/logs</code> - لاگ‌های خطایابی و سیستمی\n` +
      `• <code>/broadcast</code> - ارسال پیام همگانی\n` +
      `• <code>/cleancache</code> - پاکسازی و تبدیل فرمول‌های ذخیره‌شده قبلی\n` +
      `• <code>/clearcache</code> - پاکسازی کامل حافظه کش تحلیل‌ها`;
  }
  return text;
}

// ─── نمایش کارت اطلاعات و مدیریت کاربر (اختصاصی ادمین) ───────────
async function sendUserCard(chatId, targetId, env, editMsgId = null, fromPage = 1) {
  const stats = await getOrFetchUserInfo(env, targetId);
  const users = await getAllowedUsers(env);
  const isMem = users.includes(targetId);

  const nameDisplay = escapeHtml(stats.name && stats.name !== "بدون سابقه" && stats.name !== "نامشخص" ? stats.name : "کاربر تلگرام");
  const usernameStr = stats.username ? `@${escapeHtml(stats.username)}` : "ندارد (حساب شخصی بدون یوزرنیم)";
  const statusStr = targetId === ADMIN_ID ? "👑 ادمین اصلی" : isMem ? "✅ عضو مجاز" : "❌ نامجاز / لغو دسترسی";
  const lastUsedStr = stats.lastUsed ? new Date(stats.lastUsed).toLocaleString("fa-IR") : "هنوز ثبت نشده";

  let bioStr = "";
  if (stats.bio) {
    bioStr = `▫️ بیوگرافی تلگرام: <i>${escapeHtml(stats.bio)}</i>\n`;
  }

  const cardText =
    `👤 <b>کارت اطلاعات و مدیریت کاربر:</b>\n\n` +
    `▫️ نام تلگرام: <a href="tg://user?id=${targetId}"><b>${nameDisplay}</b></a>\n` +
    `▫️ یوزرنیم: <b>${usernameStr}</b>\n` +
    `▫️ شناسه عددی (ID): <code>${targetId}</code>\n` +
    `▫️ وضعیت دسترسی: <b>${statusStr}</b>\n` +
    `▫️ تعداد کل تحلیل‌ها: <b>${stats.totalCount || 0}</b> بار\n` +
    `▫️ آخرین فعالیت: <b>${lastUsedStr}</b>\n` +
    bioStr +
    `\n<i>💡 حتی اگر این کاربر یوزرنیم نداشته باشد یا پی‌وی او بسته باشد، با زدن دکمه «ارسال پیام مستقیم» ربات فوراً پیام شما را در چت ربات به او تحویل می‌دهد.</i>`;

  const buttons = [
    [{ text: "💬 ارسال پیام مستقیم به این کاربر", callback_data: `admin_reply_${targetId}` }],
  ];

  if (targetId !== ADMIN_ID) {
    if (isMem) {
      buttons.push([{ text: "➖ قطع دسترسی و حذف از ربات", callback_data: `rem_${targetId}` }]);
    } else {
      buttons.push([{ text: "➕ تایید و دادن مجدد دسترسی", callback_data: `approve_${targetId}` }]);
    }
  }

  buttons.push([
    { text: `👥 بازگشت به لیست اعضا (صفحه ${fromPage})`, callback_data: `admin_list_page_${fromPage}` },
    { text: "⚙️ پنل ادمین", callback_data: "admin_panel" },
  ]);

  if (editMsgId) {
    await editMessage(chatId, editMsgId, cardText, { reply_markup: { inline_keyboard: buttons } });
  } else {
    await sendMessage(chatId, cardText, { reply_markup: { inline_keyboard: buttons } });
  }
}

// ─── Update Handler ──────────────────────────────────────────
async function handleUpdate(update, env) {
  setupConfig(env);
  // Callback queries (دکمه‌های شیشه‌ای)
  if (update.callback_query) {
    const cb = update.callback_query;
    const userId = cb.from.id;
    const chatId = cb.message.chat.id;
    const msgId = cb.message.message_id;
    const data = cb.data;

    // دکمه خنثی / بدون عمل
    if (data === "noop") {
      await answerCallback(cb.id);
      return;
    }

    // پردازش انتخاب حالت تحلیل ویدیو (خلاصه کوتاه، تحلیل کامل، یا شرح ویدیو)
    if (data.startsWith("act_quick_") || data.startsWith("act_full_") || data.startsWith("act_desc_")) {
      let mode = "full";
      if (data.startsWith("act_quick_")) mode = "quick";
      else if (data.startsWith("act_desc_")) mode = "desc";

      const videoId = data.replace(
        mode === "quick" ? "act_quick_" : mode === "desc" ? "act_desc_" : "act_full_",
        ""
      );
      const ytUrl = `https://www.youtube.com/watch?v=${videoId}`;

      const allowed = await isAllowed(env, userId);
      if (!allowed) {
        await answerCallback(cb.id, "⛔️ شما به این ربات دسترسی ندارید.", true);
        return;
      }

      await answerCallback(cb.id);
      await sendTyping(chatId);

      let modeTitle = "🔍 تحلیل جامع و کامل";
      if (mode === "quick") modeTitle = "⚡️ خلاصه کوتاه و سریع";
      else if (mode === "desc") modeTitle = "⏱ شرح صحنه‌به‌صحنه ویدیو";

      const currentMsgText = cb.message?.text || "";
      const isExistingAnalysis =
        currentMsgText.includes("تحلیل کامل") ||
        currentMsgText.includes("خلاصه سریع") ||
        currentMsgText.includes("شرح صحنه‌به‌صحنه") ||
        currentMsgText.includes("مدل هوش مصنوعی");

      let targetMsgId = msgId;

      if (isExistingAnalysis) {
        // ارسال پیام جدید به منظور حفظ تحلیل قبلی در تاریخچه چت کاربر
        const newMsg = await sendMessage(
          chatId,
          `🎬 <b>در حال پردازش و استخراج (${modeTitle})...</b>\n\n⏳ لطفاً چند لحظه شکیبا باشید...`
        );
        if (newMsg && newMsg.result && newMsg.result.message_id) {
          targetMsgId = newMsg.result.message_id;
        }
      } else {
        await editMessage(
          chatId,
          msgId,
          `🎬 <b>در حال پردازش ویدیو (${modeTitle})...</b>\n\n⏳ هوش مصنوعی در حال پردازش و استخراج اطلاعات ویدیو است، لطفاً چند لحظه شکیبا باشید...`
        );
      }

      try {
        const { result, meta, modelName, fromCache } = await analyzeYouTube(videoId, ytUrl, mode, env);

        const userName = [cb.from.first_name, cb.from.last_name].filter(Boolean).join(" ");
        const userUsername = cb.from.username || null;
        await recordUsage(env, userId, userName, userUsername);
        await addSystemLog(env, "SUCCESS", `پردازش موفق (${mode}${fromCache ? " - Cache" : ""}) برای کاربر ${userId}`, {
          userId,
          mode,
          model: modelName,
          fromCache: !!fromCache,
        });

        let header = `🎬 <b>تحلیل کامل و جامع ویدیو</b>\n\n`;
        if (mode === "quick") {
          header = `⚡️ <b>خلاصه سریع و کوتاه ویدیو</b>\n\n`;
        } else if (mode === "desc") {
          header = `⏱ <b>شرح صحنه‌به‌صحنه و وقایع ویدیو</b>\n\n`;
        }

        if (meta?.title || meta?.author) {
          header += `<blockquote expandable>📌 <b>${escapeHtml(meta.title || "ویدیو یوتیوب")}</b>\n`;
          if (meta.author) header += `👤 <i>${escapeHtml(meta.author)}</i>\n`;
          if (meta.duration > 0) header += `⏳ مدت زمان: <b>${formatDuration(meta.duration)}</b>\n`;
          header += `🔗 <a href="${ytUrl}">لینک مستقیم ویدیو در یوتیوب</a></blockquote>\n\n`;
        } else {
          header += `<blockquote>🔗 <a href="${ytUrl}">${ytUrl}</a></blockquote>\n\n`;
        }

        if (meta?.duration && meta.duration > 3000) {
          header += `⚠️ <i>توجه: مدت زمان این ویدیو بیش از ۵۰ دقیقه است؛ تحلیل به صورت متنی انجام شده و ممکن است کیفیت جزئیات ثانیه‌ای کمتر باشد.</i>\n\n`;
        }

        let footer = `\n\n🤖 <i>مدل هوش مصنوعی: <b>${escapeHtml(modelName || "Google Gemini")}</b></i>`;
        if (fromCache) {
          footer += ` ⚡️ <i>(تحویل آنی از حافظه کش)</i>`;
        }
        const fullText = header + result + footer;

        const donateLink = await getDonateLink(env);
        let switchRow;
        if (mode === "quick") {
          switchRow = [
            { text: "🔍 تحلیل کامل و جامع", callback_data: `act_full_${videoId}` },
            { text: "⏱ شرح ویدیو (تا ۵۰ دقیقه)", callback_data: `act_desc_${videoId}` },
          ];
        } else if (mode === "full") {
          switchRow = [
            { text: "⚡️ خلاصه سریع", callback_data: `act_quick_${videoId}` },
            { text: "⏱ شرح ویدیو (تا ۵۰ دقیقه)", callback_data: `act_desc_${videoId}` },
          ];
        } else {
          switchRow = [
            { text: "⚡️ خلاصه سریع", callback_data: `act_quick_${videoId}` },
            { text: "🔍 تحلیل کامل و جامع", callback_data: `act_full_${videoId}` },
          ];
        }

        const navRow = [
          { text: "📊 وضعیت مصرف من", callback_data: "my_status" },
          { text: "📖 راهنما", callback_data: "user_help" },
        ];

        const rows = [switchRow, navRow];
        if (donateLink) {
          rows.push([{ text: "☕️ حمایت مالی / دونیت", url: donateLink }]);
        }

        const finishButtons = { inline_keyboard: rows };

        const chunks = splitTextChunks(fullText, 3900);
        let editSucceeded = false;

        if (chunks.length === 1) {
          try {
            const editRes = await tgCall("editMessageText", {
              chat_id: chatId,
              message_id: targetMsgId,
              text: chunks[0],
              parse_mode: "HTML",
              disable_web_page_preview: true,
              reply_markup: finishButtons,
            });
            if (editRes && editRes.ok) {
              editSucceeded = true;
            }
          } catch {}
        } else {
          // متن تحلیل طولانی است؛ ارسال چندبخشی پیوسته بدون قطع شدن حتی یک خط
          try {
            const editRes = await tgCall("editMessageText", {
              chat_id: chatId,
              message_id: targetMsgId,
              text: chunks[0],
              parse_mode: "HTML",
              disable_web_page_preview: true,
            });
            if (editRes && editRes.ok) {
              editSucceeded = true;
              for (let c = 1; c < chunks.length; c++) {
                const isLast = c === chunks.length - 1;
                await sendMessage(chatId, chunks[c], {
                  reply_markup: isLast ? finishButtons : undefined,
                  disable_web_page_preview: true,
                });
              }
            }
          } catch {}
        }

        if (!editSucceeded) {
          // فال‌بک ۱: ارسال به فرمت متن تمیز در صورت بروز هرگونه خطای پارس HTML
          try {
            const plainChunks = splitTextChunks(fullText.replace(/<[^>]+>/g, ""), 3900);
            const plainRes = await tgCall("editMessageText", {
              chat_id: chatId,
              message_id: targetMsgId,
              text: plainChunks[0],
              disable_web_page_preview: true,
              reply_markup: plainChunks.length === 1 ? finishButtons : undefined,
            });
            if (plainRes && plainRes.ok) {
              editSucceeded = true;
              for (let c = 1; c < plainChunks.length; c++) {
                const isLast = c === plainChunks.length - 1;
                await sendMessage(chatId, plainChunks[c], {
                  reply_markup: isLast ? finishButtons : undefined,
                  disable_web_page_preview: true,
                });
              }
            }
          } catch {}
        }

        if (!editSucceeded) {
          // فال‌بک ۲: ارسال پیام مجزا تا کاربر هرگز در حالت بارگذاری معلق نماند
          await sendMessage(chatId, fullText.substring(0, 4000), { reply_markup: finishButtons });
        }
      } catch (err) {
        await addSystemLog(env, "ERROR", `خطا در پردازش ویدیو برای کاربر ${userId}`, {
          userId,
          error: err.message,
        });

        const errText = `❌ <b>خطا در پردازش ویدیو:</b>\n<code>${escapeHtml(err.message)}</code>\n\nلطفاً چند ثانیه دیگر دوباره امتحان کنید.`;
        const errMarkup = {
          reply_markup: {
            inline_keyboard: [
              [{ text: "🔄 تلاش مجدد", callback_data: `act_${mode}_${videoId}` }],
              [{ text: "🔙 منوی اصلی", callback_data: "main_menu" }],
            ],
          },
        };

        const res = await editMessage(chatId, targetMsgId, errText, errMarkup);
        if (!res || !res.ok) {
          await sendMessage(chatId, errText, errMarkup);
        }
      }
      return;
    }

    // راهنمای عمومی
    if (data === "user_help") {
      const currentMsgText = cb.message?.text || "";
      const isAnalysisMsg =
        currentMsgText.includes("تحلیل کامل") ||
        currentMsgText.includes("خلاصه سریع") ||
        currentMsgText.includes("شرح صحنه‌به‌صحنه") ||
        currentMsgText.includes("مدل هوش مصنوعی");

      if (isAnalysisMsg) {
        // ارسال راهنما در پیامی مجزا تا تحلیل قبلی از بین نرود و نپرد
        await answerCallback(cb.id);
        await sendMessage(chatId, getHelpText(userId === ADMIN_ID));
        return;
      }

      await answerCallback(cb.id);
      await editMessage(chatId, msgId, getHelpText(userId === ADMIN_ID), {
        reply_markup: {
          inline_keyboard: [[{ text: "🔙 بازگشت به منوی اصلی", callback_data: "main_menu" }]],
        },
      });
      return;
    }

    // وضعیت حساب کاربر
    if (data === "my_status") {
      const stats = await getUserStats(env, userId);
      const isAdm = userId === ADMIN_ID;

      const currentMsgText = cb.message?.text || "";
      const isAnalysisMsg =
        currentMsgText.includes("تحلیل کامل") ||
        currentMsgText.includes("خلاصه سریع") ||
        currentMsgText.includes("شرح صحنه‌به‌صحنه") ||
        currentMsgText.includes("مدل هوش مصنوعی");

      if (isAnalysisMsg) {
        // نمایش به صورت پنجره پاپ‌آپ (Alert) اختصاصی تلگرام تا تحلیل ویدیو به هیچ وجه پاک نشود
        const alertText =
          `📊 وضعیت حساب شما:\n\n` +
          `👤 شناسه کاربری: ${userId}\n` +
          `🎖 سطح دسترسی: ${isAdm ? "👑 ادمین اصلی" : "✅ کاربر مجاز"}\n` +
          `📈 تعداد کل آنالیزها: ${stats.totalCount} بار\n` +
          `⏱ آخرین استفاده: ${stats.lastUsed ? new Date(stats.lastUsed).toLocaleString("fa-IR") : "هنوز ثبت نشده"}`;
        await answerCallback(cb.id, alertText, true);
        return;
      }

      await answerCallback(cb.id);
      const statusText = `📊 <b>وضعیت حساب شما:</b>\n\n` +
        `👤 شناسه کاربری: <code>${userId}</code>\n` +
        `🎖 سطح دسترسی: ${isAdm ? "👑 ادمین اصلی" : "✅ کاربر مجاز"}\n` +
        `📈 تعداد کل آنالیزها: <b>${stats.totalCount}</b> بار\n` +
        `⏱ آخرین استفاده: ${stats.lastUsed ? new Date(stats.lastUsed).toLocaleString("fa-IR") : "هنوز ثبت نشده"}`;
      await editMessage(chatId, msgId, statusText, {
        reply_markup: {
          inline_keyboard: [[{ text: "🔙 بازگشت", callback_data: "main_menu" }]],
        },
      });
      return;
    }

    // پشتیبانی و ارسال پیام به ادمین
    if (data === "user_support") {
      await answerCallback(cb.id);
      await env.BOT_KV.put(`state_${userId}`, "waiting_support", { expirationTtl: 600 });
      await sendMessage(
        chatId,
        `💬 <b>ارتباط با پشتیبانی و مدیریت ربات</b>\n\n` +
        `لطفاً پیام، نظر، سوال یا گزارش مشکل خود را در قالب یک پیام متنی بفرستید تا مستقیماً به دست ادمین برسد:\n\n` +
        `<i>(جهت انصراف، کلمه <b>لغو</b> را بفرستید یا دکمه زیر را لمس کنید)</i>`,
        {
          reply_markup: {
            inline_keyboard: [[{ text: "🔙 انصراف و بازگشت", callback_data: "main_menu" }]],
          },
        }
      );
      return;
    }

    // بازگشت به منوی اصلی
    if (data === "main_menu") {
      await answerCallback(cb.id);
      const isAdm = userId === ADMIN_ID;
      const donateLink = await getDonateLink(env);
      await editMessage(
        chatId,
        msgId,
        `سلام <b>${escapeHtml(cb.from.first_name || "کاربر")}</b> گرامی! 👋\n\n` +
        `🎬 <b>ربات تحلیلگر هوشمند ویدیوهای یوتیوب</b>\n\n` +
        `لینک ویدیوی مورد نظرت رو بفرست تا خلاصه و تحلیلش رو به فارسی تحویلت بدم.`,
        { reply_markup: mainUserKeyboard(isAdm, donateLink) }
      );
      return;
    }

    // تایید دسترسی کاربر توسط ادمین
    if (data.startsWith("approve_")) {
      if (userId !== ADMIN_ID) {
        await answerCallback(cb.id, "⛔ فقط ادمین اصلی اجازه تایید دارد.", true);
        return;
      }
      const targetId = parseInt(data.replace("approve_", ""));
      const users = await getAllowedUsers(env);
      if (!users.includes(targetId)) {
        users.push(targetId);
        await setAllowedUsers(env, users);
      }
      await answerCallback(cb.id, `✅ دسترسی کاربر ${targetId} تایید شد.`);

      const donateLink = await getDonateLink(env);
      // اطلاع‌رسانی به کاربر
      await sendMessage(
        targetId,
        `🎉 <b>تبریک! دسترسی شما به ربات توسط ادمین تایید شد.</b>\n\n` +
        `اکنون می‌توانید هر لینک ویدیوی یوتیوب را بفرستید تا تحلیل و خلاصه‌اش را دریافت کنید!`,
        { reply_markup: mainUserKeyboard(false, donateLink) }
      );

      // به‌روزرسانی پیام ادمین
      const originalText = cb.message.text || "";
      await editMessage(
        chatId,
        msgId,
        `${escapeHtml(originalText)}\n\n✅ <b>دسترسی این کاربر تایید و فعال گردید.</b>`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: "💬 ارسال پیام به این کاربر", callback_data: `admin_reply_${targetId}` }],
            ],
          },
        }
      );
      return;
    }

    // رد دسترسی کاربر توسط ادمین
    if (data.startsWith("reject_")) {
      if (userId !== ADMIN_ID) {
        await answerCallback(cb.id, "⛔ فقط ادمین اصلی اجازه رد دارد.", true);
        return;
      }
      const targetId = parseInt(data.replace("reject_", ""));
      await answerCallback(cb.id, `❌ درخواست کاربر ${targetId} رد شد.`);

      // اطلاع‌رسانی به کاربر
      await sendMessage(
        targetId,
        `⛔️ <b>متأسفانه درخواست دسترسی شما به این ربات توسط ادمین رد شد.</b>`
      );

      // به‌روزرسانی پیام ادمین
      const originalText = cb.message.text || "";
      await editMessage(
        chatId,
        msgId,
        `${escapeHtml(originalText)}\n\n❌ <b>درخواست دسترسی این کاربر رد شد.</b>`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: "💬 ارسال پیام به این کاربر", callback_data: `admin_reply_${targetId}` }],
            ],
          },
        }
      );
      return;
    }

    // پاسخ به کاربر توسط ادمین
    if (data.startsWith("admin_reply_")) {
      if (userId !== ADMIN_ID) {
        await answerCallback(cb.id, "⛔ فقط ادمین اصلی اجازه ارسال پیام دارد.", true);
        return;
      }
      const targetId = parseInt(data.replace("admin_reply_", ""));
      await answerCallback(cb.id);
      await env.BOT_KV.put(`state_${ADMIN_ID}`, `waiting_reply_${targetId}`, { expirationTtl: 600 });
      await sendMessage(
        chatId,
        `✍️ <b>ارسال پیام / پاسخ به کاربر:</b>\n\n` +
        `شما در حال ارسال پیام به <a href="tg://user?id=${targetId}">کاربر ${targetId}</a> هستید.\n` +
        `لطفاً متن پیام خود را بفرستید:\n\n` +
        `<i>(جهت انصراف، کلمه <b>لغو</b> یا دستور <code>/admin</code> را بفرستید)</i>`,
        {
          reply_markup: {
            inline_keyboard: [[{ text: "🔙 انصراف و بازگشت", callback_data: "admin_panel" }]],
          },
        }
      );
      return;
    }

    // بخش‌های ادمین
    if (userId !== ADMIN_ID) {
      await answerCallback(cb.id, "⛔ فقط ادمین اصلی به این بخش دسترسی دارد.", true);
      return;
    }

    if (data === "admin_panel") {
      await answerCallback(cb.id);
      const wlOn = await isWhitelistEnabled(env);
      const regOpen = await isRegistrationOpen(env);
      const donateLink = await getDonateLink(env);
      const users = await getAllowedUsers(env);

      const panelText =
        `⚙️ <b>پنل جامع مدیریت ربات یوتیوب</b>\n\n` +
        `📊 <b>وضعیت کلی سیستم:</b>\n` +
        `• 🛡 تایید عضویت: <b>${wlOn ? "روشن ✅ (نیاز به تایید دستی)" : "خاموش ❌ (آزاد و تایید خودکار)"}</b>\n` +
        `• 🚪 وضعیت عضوگیری: <b>${regOpen ? "باز 🟢 (پذیرش عضو جدید)" : "بسته 🔴 (مسدودسازی اعضای جدید)"}</b>\n` +
        `• 👥 کل اعضای مجاز: <b>${users.length} نفر</b>\n` +
        `• ☕️ وضعیت دونیت: <b>${donateLink ? "فعال ✅" : "غیرفعال ❌"}</b>\n\n` +
        `از کلیدهای زیر جهت تنظیمات و مانیتورینگ استفاده نمایید:`;

      await editMessage(chatId, msgId, panelText, {
        reply_markup: await adminKeyboard(env, donateLink),
      });
      return;
    }

    // سوئیچ تایید عضویت (روشن / خاموش)
    if (data === "admin_toggle_whitelist") {
      const current = await isWhitelistEnabled(env);
      const next = !current;
      await setWhitelistEnabled(env, next);
      await answerCallback(
        cb.id,
        next
          ? "🛡 تایید عضویت روشن شد (کاربران جدید نیاز به تایید دستی دارند)."
          : "🛡 تایید عضویت خاموش شد (کاربران جدید خودکار عضو می‌شوند).",
        true
      );
      const donateLink = await getDonateLink(env);
      const regOpen = await isRegistrationOpen(env);
      const users = await getAllowedUsers(env);

      const panelText =
        `⚙️ <b>پنل جامع مدیریت ربات یوتیوب</b>\n\n` +
        `وضعیت تایید عضویت به <b>${next ? "روشن ✅ (نیاز به تایید دستی)" : "خاموش ❌ (آزاد و تایید خودکار)"}</b> تغییر یافت.\n\n` +
        `• 🛡 تایید عضویت: <b>${next ? "روشن ✅" : "خاموش ❌"}</b>\n` +
        `• 🚪 وضعیت عضوگیری: <b>${regOpen ? "باز 🟢" : "بسته 🔴"}</b>\n` +
        `• 👥 کل اعضای مجاز: <b>${users.length} نفر</b>`;

      await editMessage(chatId, msgId, panelText, {
        reply_markup: await adminKeyboard(env, donateLink),
      });
      return;
    }

    // سوئیچ باز/بسته بودن عضوگیری
    if (data === "admin_toggle_reg") {
      const current = await isRegistrationOpen(env);
      const next = !current;
      await setRegistrationOpen(env, next);
      await answerCallback(
        cb.id,
        next
          ? "🚪 عضوگیری باز شد (پذیرش عضو جدید فعال شد)."
          : "🚪 عضوگیری بسته شد (پذیرش عضو جدید متوقف شد).",
        true
      );
      const donateLink = await getDonateLink(env);
      const wlOn = await isWhitelistEnabled(env);
      const users = await getAllowedUsers(env);

      const panelText =
        `⚙️ <b>پنل جامع مدیریت ربات یوتیوب</b>\n\n` +
        `وضعیت پذیرش عضو جدید به <b>${next ? "باز 🟢" : "بسته 🔴"}</b> تغییر یافت.\n\n` +
        `• 🛡 تایید عضویت: <b>${wlOn ? "روشن ✅" : "خاموش ❌"}</b>\n` +
        `• 🚪 وضعیت عضوگیری: <b>${next ? "باز 🟢" : "بسته 🔴"}</b>\n` +
        `• 👥 کل اعضای مجاز: <b>${users.length} نفر</b>`;

      await editMessage(chatId, msgId, panelText, {
        reply_markup: await adminKeyboard(env, donateLink),
      });
      return;
    }

    // به‌روزرسانی مشخصات بیو و منوی ربات تلگرام
    if (data === "admin_sync_bot_profile") {
      await answerCallback(cb.id, "در حال به‌روزرسانی بیوگرافی و منوی تلگرام...");
      await syncBotProfile();
      const donateLink = await getDonateLink(env);
      await editMessage(
        chatId,
        msgId,
        `✅ <b>بیوگرافی، توضیحات خوش‌آمدگویی و منوی دستورات ربات در تلگرام با موفقیت به‌روزرسانی شدند!</b>`,
        { reply_markup: await adminKeyboard(env, donateLink) }
      );
      return;
    }

    // تبدیل و تمیزسازی فرمول‌های ریاضی و کدهای لاتکس پیام‌های کش‌شده از قبل
    if (data === "admin_clean_cache") {
      await answerCallback(cb.id, "در حال بررسی و تبدیل فرمول‌های کش‌شده...");
      let cursor = null;
      let cleanedCount = 0;
      let totalChecked = 0;
      do {
        const listRes = await env.BOT_KV.list({ prefix: "cache_", cursor, limit: 100 });
        if (listRes && listRes.keys) {
          for (const k of listRes.keys) {
            totalChecked++;
            const raw = await env.BOT_KV.get(k.name);
            if (raw) {
              try {
                const item = JSON.parse(raw);
                if (item && item.result && hasLatexMath(item.result)) {
                  item.result = cleanLatexMathInHtml(item.result);
                  await env.BOT_KV.put(k.name, JSON.stringify(item), { expirationTtl: 2592000 });
                  cleanedCount++;
                }
              } catch {}
            }
          }
        }
        cursor = listRes?.cursor || null;
      } while (cursor);

      const donateLink = await getDonateLink(env);
      await editMessage(
        chatId,
        msgId,
        `✅ <b>پاکسازی فرمول‌های ریاضی در پیام‌های کش‌شده پایان یافت!</b>\n\n` +
        `🔍 تعداد کل تحلیل‌های ذخیره‌شده بررسی‌شده: <b>${totalChecked}</b>\n` +
        `✨ تعداد تحلیل‌های حاوی لاتکس که به یونیکد تبدیل شدند: <b>${cleanedCount}</b>\n\n` +
        `از این پس تمامی پیام‌های قدیمی و جدید به صورت کاملاً تمیز و با نمادهای خوانای تلگرام ارسال خواهند شد.`,
        { reply_markup: await adminKeyboard(env, donateLink) }
      );
      return;
    }

    // حذف کامل حافظه کش تحلیل‌ها
    if (data === "admin_clear_cache") {
      await answerCallback(cb.id, "در حال حذف حافظه کش...");
      let cursor = null;
      let deletedCount = 0;
      do {
        const listRes = await env.BOT_KV.list({ prefix: "cache_", cursor, limit: 100 });
        if (listRes && listRes.keys) {
          for (const k of listRes.keys) {
            await env.BOT_KV.delete(k.name);
            deletedCount++;
          }
        }
        cursor = listRes?.cursor || null;
      } while (cursor);

      const donateLink = await getDonateLink(env);
      await editMessage(
        chatId,
        msgId,
        `🗑 <b>حافظه موقت (کش) به طور کامل پاک شد!</b>\n\n` +
        `تعداد <b>${deletedCount}</b> تحلیل ذخیره‌شده حذف گردید. درخواست‌های بعدی کاربران به صورت تازه با هوش مصنوعی و فرمت جدید پردازش خواهند شد.`,
        { reply_markup: await adminKeyboard(env, donateLink) }
      );
      return;
    }

    // لیست اعضای ربات با قابلیت صفحه‌بندی هوشمند (۲۰ کاربر در هر صفحه)
    if (data === "admin_list" || data.startsWith("admin_list_page_")) {
      await answerCallback(cb.id);
      const users = await getAllowedUsers(env);
      const PAGE_SIZE = 20;
      const totalPages = Math.max(1, Math.ceil(users.length / PAGE_SIZE));
      let page = 1;
      if (data.startsWith("admin_list_page_")) {
        page = parseInt(data.replace("admin_list_page_", "")) || 1;
      }
      page = Math.max(1, Math.min(page, totalPages));

      const startIndex = (page - 1) * PAGE_SIZE;
      const pageUsers = users.slice(startIndex, startIndex + PAGE_SIZE);

      const items = [];
      for (let i = 0; i < pageUsers.length; i++) {
        const id = pageUsers[i];
        const stats = await getOrFetchUserInfo(env, id);
        const globalIndex = startIndex + i + 1;
        const tag = id === ADMIN_ID ? " 👑 <i>(شما)</i>" : "";
        const usernameStr = stats.username ? ` (@${escapeHtml(stats.username)})` : " <i>[بدون یوزرنیم]</i>";
        const nameDisplay = escapeHtml(stats.name && stats.name !== "بدون سابقه" && stats.name !== "نامشخص" ? stats.name : "کاربر تلگرام");
        const userLink = `<a href="tg://user?id=${id}">${nameDisplay}</a>`;
        items.push(
          `${globalIndex}. ${userLink}${usernameStr}${tag}\n` +
          `   └ شناسه: <code>${id}</code> | تحلیل: <b>${stats.totalCount || 0}</b> بار | مدیریت: /u_${id}`
        );
      }

      const listStr = items.length > 0 ? items.join("\n\n") : "<i>هیچ عضوی در سیستم ثبت نشده است.</i>";

      const navButtons = [];
      if (page > 1) {
        navButtons.push({ text: "◀️ قبلی", callback_data: `admin_list_page_${page - 1}` });
      }
      navButtons.push({ text: `📄 ${page} از ${totalPages}`, callback_data: "noop" });
      if (page < totalPages) {
        navButtons.push({ text: "بعدی ▶️", callback_data: `admin_list_page_${page + 1}` });
      }

      const keyboard = {
        inline_keyboard: [
          ...(navButtons.length > 0 ? [navButtons] : []),
          [
            { text: "🔍 جستجو / کارت کاربر با آیدی", callback_data: "admin_find_user" },
            { text: "➕ افزودن عضو", callback_data: "admin_add" },
          ],
          [{ text: "🔙 برگشت به پنل ادمین", callback_data: "admin_panel" }],
        ],
      };

      await editMessage(
        chatId,
        msgId,
        `👥 <b>لیست اعضای ربات (کل: ${users.length} نفر) - صفحه ${page} از ${totalPages}:</b>\n` +
        `<i>(💡 برای دیدن کارت کامل، ارسال پیام مستقیم یا حذف هر کاربر، دستور <code>/u_شناسه</code> را لمس نمایید)</i>\n\n${listStr}`,
        { reply_markup: keyboard }
      );
      return;
    }

    // جستجوی کاربر با شناسه عددی
    if (data === "admin_find_user") {
      await answerCallback(cb.id);
      await env.BOT_KV.put(`state_${ADMIN_ID}`, "waiting_find_user", { expirationTtl: 300 });
      await editMessage(
        chatId,
        msgId,
        `🔍 <b>جستجو و مدیریت کاربر</b>\n\n` +
        `لطفاً آیدی عددی تلگرام کاربر مورد نظر را بفرستید تا کارت مشخصات، امکان ارسال پیام مستقیم به پی‌وی و مدیریت دسترسی او نمایش داده شود:\n\n` +
        `<i>(جهت انصراف، کلمه <b>لغو</b> یا دستور <code>/admin</code> را بفرستید)</i>`,
        {
          reply_markup: {
            inline_keyboard: [[{ text: "🔙 برگشت به لیست اعضا", callback_data: "admin_list" }]],
          },
        }
      );
      return;
    }

    if (data === "admin_donate") {
      await answerCallback(cb.id);
      const donateLink = await getDonateLink(env);
      if (donateLink) {
        await editMessage(
          chatId,
          msgId,
          `☕️ <b>مدیریت لینک دونیت (حمایت مالی)</b>\n\n` +
          `🔗 لینک فعال فعلی:\n<code>${escapeHtml(donateLink)}</code>\n\n` +
          `می‌توانید لینک جدیدی ثبت کرده یا لینک قبلی را حذف کنید:`,
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: "✏️ تغییر لینک دونیت", callback_data: "donate_set" }],
                [{ text: "🗑 حذف لینک دونیت", callback_data: "donate_delete" }],
                [{ text: "🔙 برگشت به پنل ادمین", callback_data: "admin_panel" }],
              ],
            },
          }
        );
      } else {
        await editMessage(
          chatId,
          msgId,
          `☕️ <b>تنظیم لینک دونیت (حمایت مالی)</b>\n\n` +
          `در حال حاضر هیچ لینک دونیتی در ربات تنظیم نشده است.\n\n` +
          `پس از ثبت، دکمه شیشه‌ای حمایت مالی در منوی اصلی و زیر تمام پیام‌های تحلیل ویدیو برای کاربران نمایش داده خواهد شد.`,
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: "➕ ثبت لینک دونیت جدید", callback_data: "donate_set" }],
                [{ text: "🔙 برگشت به پنل ادمین", callback_data: "admin_panel" }],
              ],
            },
          }
        );
      }
      return;
    }

    if (data === "donate_set") {
      await answerCallback(cb.id);
      await env.BOT_KV.put(`state_${userId}`, "waiting_donate", { expirationTtl: 300 });
      await editMessage(
        chatId,
        msgId,
        `☕️ <b>ثبت لینک دونیت / حمایت مالی</b>\n\n` +
        `لطفاً آدرس کامل اینترنتی لینک حمایت مالی خود را ارسال کنید.\n` +
        `<i>(مثال: <code>https://reymit.ir/yourname</code> یا درگاه پرداخت دلخواه شما)</i>\n\n` +
        `جهت انصراف، کلمه <b>لغو</b> یا دستور <code>/admin</code> را بفرستید.`,
        {
          reply_markup: {
            inline_keyboard: [[{ text: "🔙 انصراف و بازگشت", callback_data: "admin_donate" }]],
          },
        }
      );
      return;
    }

    if (data === "donate_delete") {
      await setDonateLink(env, "");
      await answerCallback(cb.id, "✅ لینک دونیت حذف شد.", true);
      const donateLink = await getDonateLink(env);
      await editMessage(
        chatId,
        msgId,
        "✅ <b>لینک دونیت با موفقیت حذف شد.</b>\nاز این پس دکمه دونیت در پیام‌ها نمایش داده نخواهد شد.",
        { reply_markup: await adminKeyboard(env, donateLink) }
      );
      return;
    }

    if (data === "admin_add") {
      await answerCallback(cb.id);
      await editMessage(
        chatId,
        msgId,
        "➕ <b>افزودن کاربر جدید</b>\n\n" +
        "لطفاً آیدی عددی تلگرام کاربر را ارسال کنید.\n" +
        "<i>(مثال: <code>123456789</code>)</i>\n\n" +
        "جهت لغو، دستور <code>/admin</code> را بفرستید.",
        {
          reply_markup: {
            inline_keyboard: [[{ text: "🔙 انصراف و بازگشت", callback_data: "admin_panel" }]],
          },
        }
      );
      await env.BOT_KV.put(`state_${userId}`, "waiting_add", { expirationTtl: 300 });
      return;
    }

    if (data === "admin_remove") {
      await answerCallback(cb.id);
      await env.BOT_KV.put(`state_${userId}`, "waiting_remove_id", { expirationTtl: 300 });
      await editMessage(
        chatId,
        msgId,
        `➖ <b>حذف و قطع دسترسی کاربر:</b>\n\n` +
        `لطفاً آیدی عددی تلگرام کاربری که می‌خواهید حذف شود را ارسال کنید:\n\n` +
        `<i>(همچنین می‌توانید از بخش «👥 اعضا»، روی دستور <code>/u_شناسه</code> کاربر بزنید و دکمه حذف را لمس نمایید)</i>`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: "👥 رفتن به لیست اعضا", callback_data: "admin_list" }],
              [{ text: "🔙 انصراف و بازگشت", callback_data: "admin_panel" }],
            ],
          },
        }
      );
      return;
    }

    if (data.startsWith("rem_")) {
      const targetId = parseInt(data.replace("rem_", ""));
      const users = await getAllowedUsers(env);
      await setAllowedUsers(env, users.filter((id) => id !== targetId));
      await answerCallback(cb.id, `✅ دسترسی کاربر ${targetId} قطع شد.`, true);
      await sendUserCard(chatId, targetId, env, msgId, 1);
      return;
    }

    // باز کردن کارت کاربر از طریق کال‌بک
    if (data.startsWith("u_card_")) {
      const parts = data.replace("u_card_", "").split("_");
      const targetId = parseInt(parts[0]);
      const fromPage = parseInt(parts[1]) || 1;
      await answerCallback(cb.id);
      await sendUserCard(chatId, targetId, env, msgId, fromPage);
      return;
    }

    // گزارش و آمار مصرف کاربران
    if (data === "admin_stats") {
      await answerCallback(cb.id);
      const users = await getAllowedUsers(env);

      // جمع‌آوری آمار و محاسبه پرمصرف‌ترین‌ها
      const userStatsList = [];
      let totalAnalysesAll = 0;
      for (const uid of users) {
        const s = await getUserStats(env, uid);
        totalAnalysesAll += (s.totalCount || 0);
        userStatsList.push({ id: uid, stats: s });
      }

      userStatsList.sort((a, b) => (b.stats.totalCount || 0) - (a.stats.totalCount || 0));
      const topUsers = userStatsList.slice(0, 15);

      let statsText = `📈 <b>گزارش و آمار مصرف کاربران:</b>\n\n` +
        `• 👥 کل اعضای مجاز: <b>${users.length} نفر</b>\n` +
        `• 🎬 کل آنالیزهای ثبت‌شده در ربات: <b>${totalAnalysesAll} بار</b>\n\n` +
        `🏆 <b>پرمصرف‌ترین کاربران (Top 15):</b>\n`;

      topUsers.forEach((u, idx) => {
        const s = u.stats;
        const nameDisplay = escapeHtml(s.name && s.name !== "بدون سابقه" && s.name !== "نامشخص" ? s.name : "کاربر تلگرام");
        const uTag = u.id === ADMIN_ID ? " 👑 (ادمین)" : "";
        statsText += `${idx + 1}. <a href="tg://user?id=${u.id}">${nameDisplay}</a>${uTag}\n   └ شناسه: <code>${u.id}</code> | <b>${s.totalCount || 0}</b> تحلیل | مدیریت: /u_${u.id}\n`;
      });

      const buttons = [
        [{ text: "👥 مشاهده لیست کامل اعضا (صفحه‌بندی)", callback_data: "admin_list" }],
        [{ text: "🔍 کارت و مشخصات کاربر با آیدی", callback_data: "admin_find_user" }],
        [{ text: "🔙 برگشت به پنل ادمین", callback_data: "admin_panel" }],
      ];

      await editMessage(chatId, msgId, statsText, { reply_markup: { inline_keyboard: buttons } });
      return;
    }

    if (data.startsWith("stat_")) {
      const targetId = parseInt(data.replace("stat_", ""));
      await answerCallback(cb.id);
      const stats = await getUserStats(env, targetId);

      let historyText = "<i>هنوز تحلیلی ثبت نشده است.</i>";
      if (stats.history && stats.history.length > 0) {
        historyText = stats.history
          .map((h, i) => `${i + 1}. <b>${new Date(h.time).toLocaleDateString("fa-IR")} ساعت ${new Date(h.time).toLocaleTimeString("fa-IR")}</b> - ۱ درخواست موفق`)
          .join("\n");
      }

      const isUserAdmin = targetId === ADMIN_ID;
      const nameDisplay = escapeHtml(stats.name || "کاربر");
      const report = `📊 <b>شناسنامه کاربر:</b> <a href="tg://user?id=${targetId}">${nameDisplay}</a>\n\n` +
        `▫️ شناسه عددی: <code>${targetId}</code>\n` +
        (stats.username ? `▫️ یوزرنیم: @${escapeHtml(stats.username)}\n` : "") +
        `▫️ مجموع تحلیل‌های موفق: <b>${stats.totalCount || 0}</b> بار\n` +
        `▫️ آخرین استفاده: <b>${stats.lastUsed ? new Date(stats.lastUsed).toLocaleString("fa-IR") : "هنوز ثبت نشده"}</b>\n\n` +
        `📋 <b>تاریخچه فعالیت‌های اخیر:</b>\n${historyText}`;

      const statButtons = [
        [{ text: "💬 ارسال پیام مستقیم به این کاربر", callback_data: `admin_reply_${targetId}` }],
      ];

      if (!isUserAdmin) {
        statButtons.push([{ text: "🗑 قطع دسترسی و حذف", callback_data: `rem_${targetId}` }]);
      }

      statButtons.push([
        { text: "🔙 لیست آمار", callback_data: "admin_stats" },
        { text: "👥 لیست اعضا", callback_data: "admin_list" },
      ]);

      await editMessage(chatId, msgId, report, { reply_markup: { inline_keyboard: statButtons } });
      return;
    }

    // مشاهده لاگ‌های سیستم برای ادمین
    if (data === "admin_logs") {
      await answerCallback(cb.id);
      const logs = await getSystemLogs(env);
      let logsText = "📋 <b>لاگ‌های سیستم (۱۰ مورد اخیر):</b>\n\n";
      if (logs.length === 0) {
        logsText += "<i>هیچ لاگی در سیستم ثبت نشده است.</i>";
      } else {
        logsText += logs
          .slice(0, 10)
          .map((l) => {
            const emoji = l.type === "ERROR" ? "🔴" : l.type === "SUCCESS" ? "🟢" : "ℹ️";
            const time = new Date(l.time).toLocaleTimeString("fa-IR");
            let line = `${emoji} <b>[${time}]</b> ${escapeHtml(l.message)}`;
            if (l.details?.error) {
              line += `\n   ❌ <code>${escapeHtml(String(l.details.error).substring(0, 150))}</code>`;
            }
            return line;
          })
          .join("\n\n");
      }

      await editMessage(chatId, msgId, logsText, {
        reply_markup: {
          inline_keyboard: [
            [
              { text: "🔄 تازه‌سازی لاگ‌ها", callback_data: "admin_logs" },
              { text: "🗑 پاکسازی لاگ‌ها", callback_data: "clear_logs" },
            ],
            [{ text: "🔙 برگشت به پنل ادمین", callback_data: "admin_panel" }],
          ],
        },
      });
      return;
    }

    // پاکسازی لاگ‌ها
    if (data === "clear_logs") {
      await env.BOT_KV.delete("system_logs");
      await answerCallback(cb.id, "✅ تمامی لاگ‌ها پاک شدند.", true);
      const donateLink = await getDonateLink(env);
      await editMessage(chatId, msgId, "📋 <b>تمامی لاگ‌های سیستم با موفقیت پاک شدند.</b>", {
        reply_markup: await adminKeyboard(env, donateLink),
      });
      return;
    }

    // مشاهده سهمیه و وضعیت کلیدهای هوش مصنوعی
    if (data === "admin_quota") {
      await answerCallback(cb.id);
      const quotaText = await getQuotaReport(env);
      await editMessage(chatId, msgId, quotaText, {
        reply_markup: {
          inline_keyboard: [
            [{ text: "🔄 تست آنلاین اتصال و سلامت کلیدها", callback_data: "test_keys" }],
            [
              { text: "📊 بروزرسانی آمار", callback_data: "admin_quota" },
              { text: "🔙 برگشت به پنل ادمین", callback_data: "admin_panel" },
            ],
          ],
        },
      });
      return;
    }

    // تست سلامت و پینگ کلیدها
    if (data === "test_keys") {
      await answerCallback(cb.id, "در حال پینگ و تست کلیدها...");
      const quotaText = await getQuotaReport(env);
      const testResult = await testKeysHealth();
      const combined = `${quotaText}\n\n🩺 <b>نتیجه پینگ و آزمایش زنده کلیدها:</b>\n${testResult}`;

      await editMessage(chatId, msgId, combined, {
        reply_markup: {
          inline_keyboard: [
            [{ text: "🔄 تست مجدد کلیدها", callback_data: "test_keys" }],
            [
              { text: "📊 گزارش سهمیه", callback_data: "admin_quota" },
              { text: "🔙 برگشت به پنل ادمین", callback_data: "admin_panel" },
            ],
          ],
        },
      });
      return;
    }

    // آغاز روند ارسال پیام همگانی
    if (data === "admin_broadcast") {
      await answerCallback(cb.id);
      await env.BOT_KV.put(`state_${userId}`, "waiting_broadcast", { expirationTtl: 600 });
      const users = await getAllowedUsers(env);
      const recipientCount = users.filter((id) => id !== ADMIN_ID).length;

      await editMessage(
        chatId,
        msgId,
        `📢 <b>ارسال پیام همگانی به تمام کاربران</b>\n\n` +
        `👥 تعداد دریافت‌کنندگان فعلی: <b>${recipientCount} کاربر</b>\n\n` +
        `لطفاً متنی که می‌خواهید برای همه ارسال شود را در پیام بعدی بنویسید یا فوروارد کنید.\n` +
        `<i>(فرمت‌بندی مانند بولد، لینک و ایموجی پشتیبانی می‌شود)</i>\n\n` +
        `جهت انصراف، کلمه <b>لغو</b> یا دستور <code>/admin</code> را بفرستید.`,
        {
          reply_markup: {
            inline_keyboard: [[{ text: "🔙 انصراف و برگشت به پنل", callback_data: "admin_panel" }]],
          },
        }
      );
      return;
    }

    // تایید و ارسال همگانی
    if (data === "bcast_confirm") {
      await answerCallback(cb.id, "در حال ارسال همگانی...");
      const rawBcast = await env.BOT_KV.get(`broadcast_${userId}`);
      if (!rawBcast) {
        await editMessage(chatId, msgId, "⚠️ زمان تایید پیام به پایان رسیده است. لطفاً مجدداً اقدام کنید.", {
          reply_markup: { inline_keyboard: [[{ text: "🔙 برگشت به پنل", callback_data: "admin_panel" }]] },
        });
        return;
      }

      await editMessage(chatId, msgId, "⏳ <b>در حال ارسال پیام به کاربران... لطفاً صبور باشید.</b>");

      const users = await getAllowedUsers(env);
      const recipients = users.filter((id) => id !== ADMIN_ID);
      let successCount = 0;
      let failCount = 0;

      for (const targetId of recipients) {
        try {
          const res = await sendMessage(
            targetId,
            `📢 <b>پیام از طرف مدیریت:</b>\n\n${rawBcast}`
          );
          if (res?.ok) {
            successCount++;
          } else {
            failCount++;
          }
        } catch {
          failCount++;
        }
        await new Promise((r) => setTimeout(r, 40));
      }

      await env.BOT_KV.delete(`broadcast_${userId}`);
      await env.BOT_KV.delete(`state_${userId}`);

      await addSystemLog(env, "INFO", `ارسال پیام همگانی انجام شد (${successCount} موفق، ${failCount} ناموفق)`, {
        successCount,
        failCount,
        totalRecipients: recipients.length,
      });

      const donateLink = await getDonateLink(env);
      await editMessage(
        chatId,
        msgId,
        `✅ <b>ارسال پیام همگانی با موفقیت انجام شد!</b>\n\n` +
        `📊 <b>گزارش ارسال:</b>\n` +
        `• 👥 کل کاربران هدف: <b>${recipients.length}</b> نفر\n` +
        `• ✅ دریافت موفق: <b>${successCount}</b> نفر\n` +
        `• ❌ ناموفق (بلاک ربات یا خطا): <b>${failCount}</b> نفر`,
        { reply_markup: await adminKeyboard(env, donateLink) }
      );
      return;
    }

    // انصراف از ارسال همگانی
    if (data === "bcast_cancel") {
      await env.BOT_KV.delete(`broadcast_${userId}`);
      await env.BOT_KV.delete(`state_${userId}`);
      await answerCallback(cb.id, "ارسال لغو شد.");
      const donateLink = await getDonateLink(env);
      await editMessage(chatId, msgId, "❌ <b>ارسال پیام همگانی لغو شد.</b>", {
        reply_markup: await adminKeyboard(env, donateLink),
      });
      return;
    }

    await answerCallback(cb.id);
    return;
  }

  // پیام‌های متنی
  if (!update.message) return;

  const msg = update.message;
  const userId = msg.from.id;
  const chatId = msg.chat.id;
  const userName = [msg.from.first_name, msg.from.last_name].filter(Boolean).join(" ");
  const userUsername = msg.from.username || null;
  const text = (msg.text || "").trim();
  if (!text) return;

  const isAdmin = userId === ADMIN_ID;

  // ثبت یا به‌روزرسانی نام و مشخصات کاربر در حافظه برای دسترسی همیشگی ادمین
  await ensureUserProfile(env, userId, userName, userUsername);

  // دستور مستقیم استعلام و مدیریت مشخصات هر کاربر: /u_شناسه یا /user_شناسه
  const uCmdMatch = text.match(/^\/(?:user|u)_([0-9]+)$/i);
  if (isAdmin && uCmdMatch) {
    const targetId = parseInt(uCmdMatch[1]);
    await sendUserCard(chatId, targetId, env, null, 1);
    return;
  }

  // بررسی وضعیت‌های در حال انتظار کاربر (ماشین وضعیت پشتیبانی و پاسخ)
  const currentState = await env.BOT_KV.get(`state_${userId}`);

  // ۱. حالت انتظار برای دریافت پیام پشتیبانی از سمت کاربر
  if (currentState === "waiting_support") {
    await env.BOT_KV.delete(`state_${userId}`);
    const donateLink = await getDonateLink(env);

    if (text === "/start" || text === "لغو" || text === "انصراف") {
      await sendMessage(chatId, "❌ <b>ارسال پیام به پشتیبانی لغو شد.</b>", {
        reply_markup: mainUserKeyboard(isAdmin, donateLink),
      });
      return;
    }

    // ارسال تیکت/پیام به ادمین همراه با لینک مستقیم کلیک‌پذیر و دکمه پاسخ
    const nameDisplay = escapeHtml(userName || "کاربر تلگرام");
    const adminMsg =
      `📩 <b>پیام جدید از پشتیبانی ربات!</b>\n\n` +
      `👤 فرستنده: <a href="tg://user?id=${userId}">${nameDisplay}</a>\n` +
      (userUsername ? `🆔 یوزرنیم: @${escapeHtml(userUsername)}\n` : "") +
      `🔢 شناسه عددی: <code>${userId}</code>\n` +
      `⏰ زمان: <b>${new Date().toLocaleTimeString("fa-IR")}</b>\n\n` +
      `📝 <b>متن پیام کاربر:</b>\n${escapeHtml(text)}`;

    await sendMessage(ADMIN_ID, adminMsg, {
      reply_markup: {
        inline_keyboard: [
          [{ text: "✍️ پاسخ به این پیام", callback_data: `admin_reply_${userId}` }],
        ],
      },
    });

    await sendMessage(
      chatId,
      `✅ <b>پیام شما با موفقیت برای پشتیبانی و مدیریت ارسال شد!</b>\n\nبه زودی بررسی شده و پاسخ در همین چت برای شما ارسال خواهد شد.`,
      { reply_markup: mainUserKeyboard(isAdmin, donateLink) }
    );
    return;
  }

  // ۲. حالت انتظار برای ارسال پاسخ مستقیم ادمین به یک کاربر
  if (isAdmin && currentState && currentState.startsWith("waiting_reply_")) {
    const targetId = parseInt(currentState.replace("waiting_reply_", ""));
    await env.BOT_KV.delete(`state_${userId}`);
    const donateLink = await getDonateLink(env);

    if (text === "/admin" || text === "لغو" || text === "انصراف") {
      await sendMessage(chatId, "❌ <b>ارسال پاسخ لغو شد.</b>", {
        reply_markup: await adminKeyboard(env, donateLink),
      });
      return;
    }

    try {
      await sendMessage(
        targetId,
        `📩 <b>پاسخ پشتیبانی ربات:</b>\n\n` +
        `${escapeHtml(text)}\n\n` +
        `<i>(در صورت نیاز به ارتباط مجدد، می‌توانید از دکمه «پشتیبانی و ارتباط با ادمین» استفاده کنید)</i>`,
        { reply_markup: mainUserKeyboard(false, donateLink) }
      );

      await sendMessage(
        chatId,
        `✅ <b>پاسخ شما با موفقیت به <a href="tg://user?id=${targetId}">کاربر ${targetId}</a> ارسال شد!</b>`,
        { reply_markup: await adminKeyboard(env, donateLink) }
      );
      await addSystemLog(env, "INFO", `پاسخ پشتیبانی به کاربر ${targetId} ارسال شد.`);
    } catch (err) {
      await sendMessage(
        chatId,
        `❌ <b>خطا در ارسال پیام به کاربر:</b>\n<code>${escapeHtml(err.message)}</code>`,
        { reply_markup: await adminKeyboard(env, donateLink) }
      );
    }
    return;
  }

  // بررسی عضویت، سیستم ثبت‌نام و سیستم تایید هویت (Whitelist)
  let allowed = await isAllowed(env, userId);

  if (!allowed) {
    // ۱. بررسی وضعیت کلی عضوگیری در ربات
    const regOpen = await isRegistrationOpen(env);
    if (!regOpen) {
      await sendMessage(
        chatId,
        `⛔️ <b>عضوگیری ربات موقتاً بسته است!</b>\n\n` +
        `در حال حاضر ثبت‌نام و پذیرش کاربران جدید در ربات متوقف شده است. لطفاً در زمان دیگری مراجعه فرمایید.`
      );
      return;
    }

    // ۲. بررسی فعال بودن تایید دستی ادمین (Whitelist)
    const wlOn = await isWhitelistEnabled(env);
    if (!wlOn) {
      // تایید خودکار و آزاد - اضافه کردن کاربر به لیست مجاز بدون معطلی
      const users = await getAllowedUsers(env);
      if (!users.includes(userId)) {
        users.push(userId);
        await setAllowedUsers(env, users);
      }
      await recordUsage(env, userId, userName, userUsername);
      allowed = true;

      // اطلاع‌رسانی عضویت جدید به ادمین همراه با لینک پی‌وی مستقیم کلیک‌پذیر
      const nameDisplay = escapeHtml(userName || "کاربر تلگرام");
      const adminAlert =
        `👤 <b>عضو جدید وارد ربات شد!</b>\n\n` +
        `▫️ نام کاربر: <a href="tg://user?id=${userId}">${nameDisplay}</a>\n` +
        (userUsername ? `▫️ یوزرنیم: @${escapeHtml(userUsername)}\n` : "") +
        `▫️ شناسه عددی: <code>${userId}</code>\n` +
        `▫️ وضعیت تایید: ✅ <b>تایید خودکار</b> (تایید دستی خاموش است)\n` +
        `▫️ زمان: <b>${new Date().toLocaleDateString("fa-IR")} ساعت ${new Date().toLocaleTimeString("fa-IR")}</b>`;

      await sendMessage(ADMIN_ID, adminAlert, {
        reply_markup: {
          inline_keyboard: [
            [{ text: "💬 ارسال پیام به این کاربر", callback_data: `admin_reply_${userId}` }],
          ],
        },
      });

      await addSystemLog(env, "INFO", `عضو جدید (تایید خودکار): ${userId}`);
    } else {
      // تایید دستی توسط ادمین الزامی است
      await sendMessage(
        chatId,
        `⏳ <b>درخواست دسترسی شما ثبت شد!</b>\n\n` +
        `شناسه تلگرام شما: <code>${userId}</code>\n\n` +
        `درخواست دسترسی شما به صورت خودکار برای مدیریت ارسال گردید. به محض تایید، ربات برای شما فعال خواهد شد.`
      );

      const nameDisplay = escapeHtml(userName || "کاربر تلگرام");
      const adminAlert =
        `🔔 <b>درخواست دسترسی کاربر جدید!</b>\n\n` +
        `👤 نام کاربر: <a href="tg://user?id=${userId}">${nameDisplay}</a>\n` +
        (userUsername ? `🆔 یوزرنیم: @${escapeHtml(userUsername)}\n` : "") +
        `🔢 شناسه عددی (ID): <code>${userId}</code>\n\n` +
        `آیا به این کاربر اجازه استفاده از ربات تحلیلگر یوتیوب را می‌دهید؟`;

      const approveButtons = {
        inline_keyboard: [
          [
            { text: "✅ تایید و دادن دسترسی", callback_data: `approve_${userId}` },
            { text: "❌ رد درخواست", callback_data: `reject_${userId}` },
          ],
          [
            { text: "💬 ارسال پیام به کاربر", callback_data: `admin_reply_${userId}` },
          ],
        ],
      };

      await sendMessage(ADMIN_ID, adminAlert, { reply_markup: approveButtons });
      return;
    }
  }

  // دستور /start
  if (text === "/start") {
    const donateLink = await getDonateLink(env);
    const welcomeText =
      `سلام <b>${escapeHtml(userName || "دوست عزیز")}</b>! 👋\n` +
      `به <b>ربات تحلیلگر هوشمند ویدیوهای یوتیوب</b> خوش آمدید. 🎬⚡️\n\n` +
      `با این ربات می‌توانید بدون نیاز به دانلود یا تماشای کامل ویدیوهای طولانی، در چند ثانیه به محتوا، اتفاقات و پیام محوری آن‌ها مسلط شوید.\n\n` +
      `📌 <b>چگونه کار می‌کند؟</b>\n` +
      `۱️⃣ کافیست لینک هر ویدیوی یوتیوب (عادی یا Shorts) را همینجا بفرستید.\n` +
      `۲️⃣ یکی از ۳ حالت زیر را انتخاب نمایید:\n` +
      `   ⚡️ <b>خلاصه سریع:</b> دریافت چکیده و پیام محوری در ۳۰ ثانیه\n` +
      `   🔍 <b>تحلیل کامل:</b> بررسی مو به مو با جعبه استدلال عمیق\n` +
      `   ⏱ <b>شرح صحنه‌به‌صحنه:</b> روایت کامل داستان با تایم‌استمپ دقیق کلیک‌پذیر\n` +
      `۳️⃣ تحلیل کامل را به زبان فارسی تحویل بگیرید! 🚀\n\n` +
      `💡 <i>نکته: ویدیوهای تا ۵۰ دقیقه به صورت ثانیه‌به‌ثانیه و فریم‌به‌فریم بررسی می‌شوند.</i>`;

    await sendMessage(chatId, welcomeText, {
      reply_markup: mainUserKeyboard(isAdmin, donateLink),
    });
    return;
  }

  // دستور /help
  if (text === "/help" || text === "راهنما") {
    const donateLink = await getDonateLink(env);
    await sendMessage(chatId, getHelpText(isAdmin), {
      reply_markup: mainUserKeyboard(isAdmin, donateLink),
    });
    return;
  }

  // دستور /support
  if (text === "/support" || text === "پشتیبانی") {
    await env.BOT_KV.put(`state_${userId}`, "waiting_support", { expirationTtl: 600 });
    await sendMessage(
      chatId,
      `💬 <b>ارتباط با پشتیبانی و مدیریت ربات</b>\n\n` +
      `لطفاً پیام، نظر، سوال یا گزارش مشکل خود را در قالب یک پیام متنی بفرستید تا مستقیماً به دست ادمین برسد:\n\n` +
      `<i>(جهت انصراف، کلمه <b>لغو</b> را بفرستید)</i>`,
      {
        reply_markup: {
          inline_keyboard: [[{ text: "🔙 انصراف و بازگشت", callback_data: "main_menu" }]],
        },
      }
    );
    return;
  }

  // دستور /admin
  if (text === "/admin") {
    if (!isAdmin) {
      await sendMessage(chatId, "⛔ این بخش فقط برای ادمین ربات در دسترس است.");
      return;
    }
    const donateLink = await getDonateLink(env);
    const wlOn = await isWhitelistEnabled(env);
    const regOpen = await isRegistrationOpen(env);
    const users = await getAllowedUsers(env);

    const panelText =
      `⚙️ <b>پنل جامع مدیریت ربات یوتیوب</b>\n\n` +
      `📊 <b>وضعیت کلی سیستم:</b>\n` +
      `• 🛡 تایید عضویت: <b>${wlOn ? "روشن ✅ (نیاز به تایید دستی)" : "خاموش ❌ (آزاد و تایید خودکار)"}</b>\n` +
      `• 🚪 وضعیت عضوگیری: <b>${regOpen ? "باز 🟢 (پذیرش عضو جدید)" : "بسته 🔴 (مسدودسازی اعضای جدید)"}</b>\n` +
      `• 👥 کل اعضای مجاز: <b>${users.length} نفر</b>\n` +
      `• ☕️ وضعیت دونیت: <b>${donateLink ? "فعال ✅" : "غیرفعال ❌"}</b>\n\n` +
      `از کلیدهای زیر جهت تنظیمات و مانیتورینگ استفاده نمایید:`;

    await sendMessage(chatId, panelText, {
      reply_markup: await adminKeyboard(env, donateLink),
    });
    return;
  }

  // دستور /logs (اختصاصی ادمین)
  if (text === "/logs") {
    if (!isAdmin) {
      await sendMessage(chatId, "⛔ این بخش فقط برای ادمین ربات در دسترس است.");
      return;
    }
    const logs = await getSystemLogs(env);
    let logsText = "📋 <b>لاگ‌های سیستم (۱۰ مورد اخیر):</b>\n\n";
    if (logs.length === 0) {
      logsText += "<i>هیچ لاگی در سیستم ثبت نشده است.</i>";
    } else {
      logsText += logs
        .slice(0, 10)
        .map((l) => {
          const emoji = l.type === "ERROR" ? "🔴" : l.type === "SUCCESS" ? "🟢" : "ℹ️";
          const time = new Date(l.time).toLocaleTimeString("fa-IR");
          let line = `${emoji} <b>[${time}]</b> ${escapeHtml(l.message)}`;
          if (l.details?.error) {
            line += `\n   ❌ <code>${escapeHtml(String(l.details.error).substring(0, 150))}</code>`;
          }
          return line;
        })
        .join("\n\n");
    }

    await sendMessage(chatId, logsText, {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "🔄 تازه‌سازی لاگ‌ها", callback_data: "admin_logs" },
            { text: "🗑 پاکسازی لاگ‌ها", callback_data: "clear_logs" },
          ],
          [{ text: "🔙 برگشت به منوی ادمین", callback_data: "admin_panel" }],
        ],
      },
    });
    return;
  }

  // دستور /status
  if (text === "/status") {
    const stats = await getUserStats(env, userId);
    const isAdm = userId === ADMIN_ID;
    const statusText = `📊 <b>وضعیت حساب شما:</b>\n\n` +
      `👤 شناسه کاربری: <code>${userId}</code>\n` +
      `🎖 سطح دسترسی: ${isAdm ? "👑 ادمین اصلی" : "✅ کاربر مجاز"}\n` +
      `📈 تعداد کل آنالیزها: <b>${stats.totalCount}</b> بار\n` +
      `⏱ آخرین استفاده: ${stats.lastUsed ? new Date(stats.lastUsed).toLocaleString("fa-IR") : "هنوز ثبت نشده"}`;
    const donateLink = await getDonateLink(env);
    await sendMessage(chatId, statusText, {
      reply_markup: mainUserKeyboard(isAdm, donateLink),
    });
    return;
  }

  // دستور /broadcast (اختصاصی ادمین)
  if (text === "/broadcast") {
    if (!isAdmin) {
      await sendMessage(chatId, "⛔ این بخش فقط برای ادمین ربات در دسترس است.");
      return;
    }
    await env.BOT_KV.put(`state_${userId}`, "waiting_broadcast", { expirationTtl: 600 });
    const users = await getAllowedUsers(env);
    const recipientCount = users.filter((id) => id !== ADMIN_ID).length;

    await sendMessage(
      chatId,
      `📢 <b>ارسال پیام همگانی به تمام کاربران</b>\n\n` +
      `👥 تعداد کاربران دریافت‌کننده: <b>${recipientCount} نفر</b>\n\n` +
      `لطفاً متنی که می‌خواهید ارسال شود را بنویسید.\n` +
      `<i>(امکان استفاده از ایموجی، متن بولد و لینک وجود دارد)</i>\n\n` +
      `جهت انصراف، کلمه <b>لغو</b> یا دستور <code>/admin</code> را بفرستید.`,
      {
        reply_markup: {
          inline_keyboard: [[{ text: "🔙 انصراف و برگشت", callback_data: "admin_panel" }]],
        },
      }
    );
    return;
  }

  // دستور /quota (داشبورد سهمیه و وضعیت کلیدها - اختصاصی ادمین)
  if (text === "/quota") {
    if (!isAdmin) {
      await sendMessage(chatId, "⛔ این بخش فقط برای ادمین ربات در دسترس است.");
      return;
    }
    const quotaText = await getQuotaReport(env);
    await sendMessage(chatId, quotaText, {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🔄 تست آنلاین اتصال و سلامت کلیدها", callback_data: "test_keys" }],
          [{ text: "🔙 منوی پنل ادمین", callback_data: "admin_panel" }],
        ],
      },
    });
    return;
  }

  // دستور /cleancache (پاکسازی و تبدیل فرمول‌های ریاضی پیام‌های ذخیره‌شده از قبل در کش)
  if (text === "/cleancache") {
    if (!isAdmin) {
      await sendMessage(chatId, "⛔ این بخش فقط برای ادمین ربات در دسترس است.");
      return;
    }
    const waitMsg = await sendMessage(chatId, "⏳ در حال بررسی و تبدیل کدهای لاتکس در تمامی تحلیل‌های کش‌شده...");
    let cursor = null;
    let cleanedCount = 0;
    let totalChecked = 0;
    do {
      const listRes = await env.BOT_KV.list({ prefix: "cache_", cursor, limit: 100 });
      if (listRes && listRes.keys) {
        for (const k of listRes.keys) {
          totalChecked++;
          const raw = await env.BOT_KV.get(k.name);
          if (raw) {
            try {
              const item = JSON.parse(raw);
              if (item && item.result && hasLatexMath(item.result)) {
                item.result = cleanLatexMathInHtml(item.result);
                await env.BOT_KV.put(k.name, JSON.stringify(item), { expirationTtl: 2592000 });
                cleanedCount++;
              }
            } catch {}
          }
        }
      }
      cursor = listRes?.cursor || null;
    } while (cursor);

    const donateLink = await getDonateLink(env);
    if (waitMsg && waitMsg.result) {
      await editMessage(
        chatId,
        waitMsg.result.message_id,
        `✅ <b>پاکسازی فرمول‌های پیام‌های کش‌شده پایان یافت!</b>\n\n` +
        `🔍 کل پیام‌های کش‌شده بررسی‌شده: <b>${totalChecked}</b>\n` +
        `✨ پیام‌های تبدیل‌شده از لاتکس خام به یونیکد: <b>${cleanedCount}</b>\n\n` +
        `از این پس تمامی پیام‌های قدیمی و جدید به صورت کاملاً تمیز نمایش داده می‌شوند.`,
        { reply_markup: await adminKeyboard(env, donateLink) }
      );
    }
    return;
  }

  // دستور /clearcache (حذف کامل حافظه موقت کش)
  if (text === "/clearcache") {
    if (!isAdmin) {
      await sendMessage(chatId, "⛔ این بخش فقط برای ادمین ربات در دسترس است.");
      return;
    }
    const waitMsg = await sendMessage(chatId, "⏳ در حال پاکسازی کل حافظه کش...");
    let cursor = null;
    let deletedCount = 0;
    do {
      const listRes = await env.BOT_KV.list({ prefix: "cache_", cursor, limit: 100 });
      if (listRes && listRes.keys) {
        for (const k of listRes.keys) {
          await env.BOT_KV.delete(k.name);
          deletedCount++;
        }
      }
      cursor = listRes?.cursor || null;
    } while (cursor);

    const donateLink = await getDonateLink(env);
    if (waitMsg && waitMsg.result) {
      await editMessage(
        chatId,
        waitMsg.result.message_id,
        `🗑 <b>حافظه کش با موفقیت پاک شد!</b>\n\nتعداد <b>${deletedCount}</b> تحلیل قدیمی حذف شدند.`,
        { reply_markup: await adminKeyboard(env, donateLink) }
      );
    }
    return;
  }

  // ماشین وضعیت‌های ادمین
  if (isAdmin) {
    const state = await env.BOT_KV.get(`state_${userId}`);
    const donateLink = await getDonateLink(env);

    if (state === "waiting_add") {
      await env.BOT_KV.delete(`state_${userId}`);

      if (text === "/admin" || text === "لغو" || text === "انصراف") {
        await sendMessage(chatId, "⚙️ <b>پنل مدیریت ادمین:</b>", { reply_markup: await adminKeyboard(env, donateLink) });
        return;
      }

      const newId = parseInt(text);
      if (isNaN(newId) || newId <= 0) {
        await sendMessage(chatId, "❌ آیدی نامعتبر بود. لطفاً فقط عدد آیدی عددی تلگرام را بفرستید.", {
          reply_markup: await adminKeyboard(env, donateLink),
        });
        return;
      }

      const users = await getAllowedUsers(env);
      if (users.includes(newId)) {
        await sendMessage(chatId, `ℹ️ کاربر <code>${newId}</code> از قبل در لیست کاربران مجاز قرار دارد.`, {
          reply_markup: await adminKeyboard(env, donateLink),
        });
        return;
      }

      users.push(newId);
      await setAllowedUsers(env, users);
      await sendMessage(chatId, `✅ کاربر با شناسه <a href="tg://user?id=${newId}">${newId}</a> با موفقیت اضافه شد و اکنون دسترسی دارد!`, {
        reply_markup: await adminKeyboard(env, donateLink),
      });

      // ارسال پیام تبریک به کاربر افزوده شده
      try {
        await sendMessage(
          newId,
          `🎉 <b>تبریک! دسترسی شما به ربات تحلیلگر یوتیوب توسط ادمین فعال شد.</b>\n\nهم‌اکنون می‌توانید لینک ویدیوی یوتیوب را ارسال نمایید.`,
          { reply_markup: mainUserKeyboard(false, donateLink) }
        );
      } catch {}
      return;
    }

    if (state === "waiting_find_user") {
      await env.BOT_KV.delete(`state_${userId}`);

      if (text === "/admin" || text === "لغو" || text === "انصراف") {
        await sendMessage(chatId, "⚙️ <b>پنل مدیریت ادمین:</b>", { reply_markup: await adminKeyboard(env, donateLink) });
        return;
      }

      const targetId = parseInt(text.replace(/[^0-9]/g, ""));
      if (isNaN(targetId) || targetId <= 0) {
        await sendMessage(chatId, "❌ شناسه نامعتبر بود. لطفاً فقط عدد آیدی عددی تلگرام را بفرستید.", {
          reply_markup: {
            inline_keyboard: [[{ text: "🔙 برگشت به لیست اعضا", callback_data: "admin_list" }]],
          },
        });
        return;
      }

      await sendUserCard(chatId, targetId, env, null, 1);
      return;
    }

    if (state === "waiting_remove_id") {
      await env.BOT_KV.delete(`state_${userId}`);

      if (text === "/admin" || text === "لغو" || text === "انصراف") {
        await sendMessage(chatId, "⚙️ <b>پنل مدیریت ادمین:</b>", { reply_markup: await adminKeyboard(env, donateLink) });
        return;
      }

      const targetId = parseInt(text.replace(/[^0-9]/g, ""));
      if (isNaN(targetId) || targetId <= 0) {
        await sendMessage(chatId, "❌ شناسه نامعتبر بود. لطفاً فقط عدد آیدی عددی تلگرام را بفرستید.", {
          reply_markup: {
            inline_keyboard: [[{ text: "🔙 برگشت به پنل ادمین", callback_data: "admin_panel" }]],
          },
        });
        return;
      }

      const users = await getAllowedUsers(env);
      if (!users.includes(targetId)) {
        await sendMessage(chatId, `ℹ️ کاربر با شناسه <code>${targetId}</code> در لیست اعضای مجاز ربات وجود ندارد.`, {
          reply_markup: await adminKeyboard(env, donateLink),
        });
        return;
      }

      await setAllowedUsers(env, users.filter((id) => id !== targetId));
      await sendMessage(chatId, `✅ دسترسی کاربر <code>${targetId}</code> با موفقیت قطع و از سیستم حذف شد.`);
      await sendUserCard(chatId, targetId, env, null, 1);
      return;
    }

    if (state === "waiting_donate") {
      await env.BOT_KV.delete(`state_${userId}`);

      if (text === "/admin" || text === "لغو" || text === "انصراف") {
        await sendMessage(chatId, "⚙️ <b>پنل مدیریت ادمین:</b>", { reply_markup: await adminKeyboard(env, donateLink) });
        return;
      }

      if (!text.startsWith("http://") && !text.startsWith("https://")) {
        await sendMessage(
          chatId,
          "❌ آدرس نامعتبر است! لینک حمایت مالی حتماً باید با <code>https://</code> یا <code>http://</code> آغاز شود.\nعملیات ثبت لغو شد.",
          { reply_markup: await adminKeyboard(env, donateLink) }
        );
        return;
      }

      await setDonateLink(env, text.trim());
      await sendMessage(
        chatId,
        `✅ <b>لینک دونیت با موفقیت ذخیره و فعال شد!</b>\n\n` +
        `🔗 آدرس: <code>${escapeHtml(text.trim())}</code>\n\n` +
        `از این پس دکمه شیشه‌ای حمایت مالی در زیر تمام آنالیزها و منوی کاربران قرار خواهد گرفت.`,
        { reply_markup: await adminKeyboard(env, text.trim()) }
      );
      return;
    }

    if (state === "waiting_broadcast") {
      await env.BOT_KV.delete(`state_${userId}`);

      if (text === "/admin" || text === "لغو" || text === "انصراف") {
        await sendMessage(chatId, "⚙️ <b>پنل مدیریت ادمین:</b>", { reply_markup: await adminKeyboard(env, donateLink) });
        return;
      }

      await env.BOT_KV.put(`broadcast_${userId}`, text, { expirationTtl: 600 });
      const users = await getAllowedUsers(env);
      const recipientCount = users.filter((id) => id !== ADMIN_ID).length;

      const previewText = `📢 <b>پیش‌نمایش پیام همگانی:</b>\n\n` +
        `────────────\n` +
        `${text}\n` +
        `────────────\n\n` +
        `👥 این پیام برای <b>${recipientCount} کاربر</b> ارسال خواهد شد.\n\n` +
        `آیا برای ارسال به تمام کاربران مطمئن هستید؟`;

      await sendMessage(chatId, previewText, {
        reply_markup: {
          inline_keyboard: [
            [
              { text: "✅ تایید و ارسال نهایی", callback_data: "bcast_confirm" },
              { text: "❌ لغو ارسال", callback_data: "bcast_cancel" },
            ],
          ],
        },
      });
      return;
    }
  }

  // پردازش لینک یوتیوب
  const ytInfo = extractYouTubeUrl(text);
  if (ytInfo) {
    await sendTyping(chatId);
    const meta = await getYouTubeMeta(ytInfo.videoId);

    if (!meta || !meta.title) {
      const donateLink = await getDonateLink(env);
      await sendMessage(
        chatId,
        `⚠️ <b>امکان دریافت مشخصات این ویدیو وجود ندارد!</b>\n\n` +
        `🔗 <code>${escapeHtml(ytInfo.url)}</code>\n\n` +
        `دسترسی به این ویدیو از سمت یوتیوب محدود است (احتمالاً ویدیو خصوصی، حذف‌شده، نامعتبر یا دارای محدودیت غیرقابل دسترس است).\n` +
        `جهت حفظ دقت و جلوگیری از هرگونه تحلیل اشتباه یا توهم هوش مصنوعی، امکان پردازش این ویدیو وجود ندارد.`,
        { reply_markup: mainUserKeyboard(isAdmin, donateLink) }
      );
      return;
    }

    let card = `🎬 <b>ویدیو یوتیوب دریافت شد!</b>\n\n` +
      `<blockquote expandable>📌 <b>${escapeHtml(meta.title)}</b>\n`;
    if (meta.author) card += `👤 <i>${escapeHtml(meta.author)}</i>\n`;
    if (meta.duration > 0) card += `⏳ مدت زمان: <b>${formatDuration(meta.duration)}</b>\n`;
    card += `🔗 <a href="${ytInfo.url}">مشاهده مستقیم در یوتیوب</a></blockquote>\n\n`;

    if (meta.duration && meta.duration > 3000) {
      card += `⚠️ <b>توجه در مورد مدت زمان ویدیو:</b>\n` +
        `<i>این ویدیو بیش از ۵۰ دقیقه است (${formatDuration(meta.duration)}). ویدیوها تا سقف ۵۰ دقیقه با نهایت دقت به صورت فریم‌به‌فریم و ثانیه‌به‌ثانیه تحلیل می‌شوند. برای ویدیوهای بالای ۵۰ دقیقه، پردازش متنی بوده و کیفیت جزئیات ثانیه‌ای کاهش می‌یابد.</i>\n\n`;
    } else {
      card += `💡 <i>نکته: تحلیل دقیق و ثانیه‌به‌ثانیه تا سقف ۵۰ دقیقه انجام می‌شود (برای ویدیوهای طولانی‌تر کیفیت کاهش می‌یابد).</i>\n\n`;
    }

    card += `نوع پاسخ مورد نظر خود را انتخاب کنید:`;

    await sendMessage(chatId, card, {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "⚡️ خلاصه کوتاه و سریع (موضوع چیه؟)", callback_data: `act_quick_${ytInfo.videoId}` },
          ],
          [
            { text: "🔍 تحلیل کامل و جامع (توش چیا میگه؟)", callback_data: `act_full_${ytInfo.videoId}` },
          ],
          [
            { text: "⏱ شرح ویدیو (روایت صحنه‌به‌صحنه تا ۵۰ دقیقه)", callback_data: `act_desc_${ytInfo.videoId}` },
          ],
        ],
      },
    });
    return;
  }

  // اگر متن فرستاده شده لینک یوتیوب نبود
  const donateLink = await getDonateLink(env);
  await sendMessage(
    chatId,
    `❓ <b>لینک معتبر یوتیوب یافت نشد!</b>\n\n` +
    `لطفاً یک لینک معتبر بفرستید یا از دکمه‌های زیر استفاده کنید:`,
    { reply_markup: mainUserKeyboard(isAdmin, donateLink) }
  );
}

// ─── Worker Entry ─────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    setupConfig(env);
    if (request.method !== "POST") {
      return new Response("YouTube Analyzer Bot ✅ Active & Running", { status: 200 });
    }
    try {
      const update = await request.json();
      ctx.waitUntil(handleUpdate(update, env));
    } catch {}
    return new Response("OK", { status: 200 });
  },
};

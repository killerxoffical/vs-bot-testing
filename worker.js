const express = require('express');
const cors = require('cors');
const { Telegraf } = require('telegraf');
const admin = require('firebase-admin');
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const path = require('path');

// Credentials
const BOT_TOKEN = process.env.BOT_TOKEN || "8590481969:AAFezVtaNE6D0QF0ss26k2SHj5tW7hCiSN8";
const API_ID = parseInt(process.env.API_ID || "39447470");
const API_HASH = process.env.API_HASH || "eb7cac1c8ad9935d4b208dc0da076d8c";
const FIREBASE_DB_URL = "https://vsprotection1-default-rtdb.firebaseio.com";

// Firebase Admin Setup
admin.initializeApp({
    credential: admin.credential.applicationDefault(), // অথবা Service Account
    databaseURL: FIREBASE_DB_URL
});
const db = admin.database();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Cron Job Keep-Alive
app.get('/ping', (req, res) => res.status(200).send("PONG - Bot is active!"));

/* ==========================================================================
   TELEGRAM BOT ENGINE (TELEGRAF)
   ========================================================================== */
const bot = new Telegraf(BOT_TOKEN);

// রিয়েল-টাইম ক্যাশ যাতে ডাটাবেস রিকোয়েস্ট দ্রুত হয়
let chatSettingsCache = {};

async function getChatSettings(chatId) {
    if (chatSettingsCache[chatId]) return chatSettingsCache[chatId];
    const snap = await db.ref(`groups/${chatId}/settings`).once('value');
    const settings = snap.val() || {
        welcome: { enabled: true, text: "স্বাগতম {user} আমাদের গ্রুপে!" },
        antiLink: { enabled: false },
        antiForward: { enabled: false },
        badWords: { enabled: false, words: [], action: 'delete' },
        warnLimit: 3,
        chatLocked: false
    };
    chatSettingsCache[chatId] = settings;
    return settings;
}

// সেটিং আপডেটের ইভেন্ট লিসেনার
db.ref('groups').on('child_changed', (snap) => {
    const val = snap.val();
    if (val && val.settings) chatSettingsCache[snap.key] = val.settings;
});

// Welcome Message Handler
bot.on('new_chat_members', async (ctx) => {
    const chatId = ctx.chat.id;
    const settings = await getChatSettings(chatId);
    if (!settings.welcome?.enabled) return;

    for (const member of ctx.message.new_chat_members) {
        if (member.is_bot) continue;
        const msg = (settings.welcome.text || "Welcome {user}!")
            .replace('{user}', `[${member.first_name}](tg://user?id=${member.id})`)
            .replace('{chat}', ctx.chat.title);
        ctx.replyWithMarkdown(msg).catch(() => {});
    }
});

// Security & Moderation Middleware
bot.on('message', async (ctx, next) => {
    if (!ctx.chat || ctx.chat.type === 'private') return next();

    const chatId = ctx.chat.id;
    const userId = ctx.from?.id;
    const text = ctx.message.text || ctx.message.caption || "";
    const settings = await getChatSettings(chatId);

    // অ্যাডমিনদের ওপর গার্ড ফিল্টার কাজ করবে না
    try {
        const member = await ctx.getChatMember(userId);
        if (['creator', 'administrator'].includes(member.status)) return next();
    } catch (e) {
        return next();
    }

    // ১. Chat Locked Check
    if (settings.chatLocked) {
        await ctx.deleteMessage().catch(() => {});
        return;
    }

    // ২. Anti-Forward Check
    if (settings.antiForward?.enabled && (ctx.message.forward_date || ctx.message.forward_origin)) {
        await ctx.deleteMessage().catch(() => {});
        return;
    }

    // ৩. Anti-Link Check
    if (settings.antiLink?.enabled) {
        const linkRegex = /(https?:\/\/[^\s]+)|(t\.me\/[^\s]+)|(telegram\.me\/[^\s]+)/gi;
        if (linkRegex.test(text)) {
            await ctx.deleteMessage().catch(() => {});
            return;
        }
    }

    // ৪. Bad Words & Custom Action Check
    if (settings.badWords?.enabled && Array.isArray(settings.badWords.words)) {
        const containsBadWord = settings.badWords.words.some(word => 
            text.toLowerCase().includes(word.trim().toLowerCase())
        );

        if (containsBadWord) {
            await ctx.deleteMessage().catch(() => {});

            const action = settings.badWords.action || 'delete';
            if (action === 'warn') {
                const warnRef = db.ref(`groups/${chatId}/warns/${userId}`);
                const snap = await warnRef.once('value');
                const warns = (snap.val() || 0) + 1;
                await warnRef.set(warns);

                if (warns >= (settings.warnLimit || 3)) {
                    await ctx.banChatMember(userId).catch(() => {});
                    await warnRef.remove();
                    ctx.reply(`🚨 @${ctx.from.username || ctx.from.first_name} কে অতিরিক্ত সতর্কবার্তা অতিক্রমের কারণে ব্যান করা হলো!`);
                } else {
                    ctx.reply(`⚠️ [${ctx.from.first_name}](tg://user?id=${userId}) আপনি নিষিদ্ধ শব্দ ব্যবহার করেছেন! সতর্কবার্তা (${warns}/${settings.warnLimit || 3})`, { parse_mode: 'Markdown' });
                }
            } else if (action === 'ban') {
                await ctx.banChatMember(userId).catch(() => {});
                ctx.reply(`⛔ নিষিদ্ধ শব্দ ব্যবহার করার কারণে @${ctx.from.username || ctx.from.first_name} কে স্থায়ী ব্যান করা হলো।`);
            }
            return;
        }
    }

    return next();
});

bot.launch().then(() => console.log("Telegraf Bot Started Successfully!"));

/* ==========================================================================
   GRAMJS MTPROTO API (USER SESSION LOGIN & AUTO-SETUP)
   ========================================================================== */
const activeClients = {}; // Temp store client during auth

// Send Code to Telegram
app.post('/api/tg/send-code', async (req, res) => {
    const { phone } = req.body;
    try {
        const client = new TelegramClient(new StringSession(""), API_ID, API_HASH, { connectionRetries: 5 });
        await client.connect();
        const { phoneCodeHash } = await client.sendCode({ apiId: API_ID, apiHash: API_HASH }, phone);
        activeClients[phone] = { client, phoneCodeHash };
        res.json({ success: true, phoneCodeHash });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Verify Code & Return Admin Groups
app.post('/api/tg/verify-code', async (req, res) => {
    const { phone, code, phoneCodeHash } = req.body;
    try {
        const sessionData = activeClients[phone];
        if (!sessionData) throw new Error("সেশন পাওয়া যায়নি! আবার চেষ্টা করুন।");
        
        const client = sessionData.client;
        await client.signInUser({ apiId: API_ID, apiHash: API_HASH }, {
            phoneNumber: phone,
            phoneCodeHash: phoneCodeHash || sessionData.phoneCodeHash,
            phoneCode: code,
        });

        const stringSession = client.session.save();
        
        // Fetch User's Admin/Creator Groups
        const dialogs = await client.getDialogs();
        const adminGroups = dialogs
            .filter(d => d.isGroup || d.isChannel)
            .map(d => ({
                id: d.id.toString(),
                title: d.title,
                membersCount: d.entity.participantsCount || 0
            }));

        res.json({ success: true, session: stringSession, groups: adminGroups });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Auto-Add Bot to Group and Promote as Admin
app.post('/api/tg/connect-group', async (req, res) => {
    const { session, chatId } = req.body;
    try {
        const client = new TelegramClient(new StringSession(session), API_ID, API_HASH, {});
        await client.connect();
        
        const botEntity = await client.getEntity(BOT_TOKEN.split(':')[0]); // Bot ID/Username
        
        // বটকে গ্রুপে অ্যাড করা এবং পূর্ণ অ্যাডমিন রাইট প্রদান
        await client.invoke(new Api.channels.EditAdmin({
            channel: chatId,
            userId: botEntity,
            adminRights: new Api.ChatAdminRights({
                changeInfo: true,
                postMessages: true,
                editMessages: true,
                deleteMessages: true,
                banUsers: true,
                inviteUsers: true,
                pinMessages: true,
                addAdmins: false,
                manageCall: true
            }),
            rank: 'Guardian Core'
        }));

        res.json({ success: true, message: "বট সফলভাবে যুক্ত হয়েছে এবং অ্যাডমিন রোল প্রদান করা হয়েছে!" });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Dashboard Server running on http://localhost:${PORT}`));
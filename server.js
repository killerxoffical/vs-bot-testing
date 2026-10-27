const express = require('express');
const cors = require('cors');
const { Telegraf } = require('telegraf');
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const path = require('path');

// Firebase Web SDK for Node.js (কোনো Service Account JSON ফাইলের ঝামেলা নেই)
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

// Initialize Firebase
if (!firebase.apps.length) {
    firebase.initializeApp(firebaseConfig);
}
const db = firebase.database();

// Constants & Env
const BOT_TOKEN = process.env.BOT_TOKEN || "8590481969:AAFezVtaNE6D0QF0ss26k2SHj5tW7hCiSN8";
const API_ID = parseInt(process.env.API_ID || "39447470");
const API_HASH = process.env.API_HASH || "eb7cac1c8ad9935d4b208dc0da076d8c";
const PORT = process.env.PORT || 3000;

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Keep-Alive Ping Route for Cron-Job
app.get('/ping', (req, res) => res.status(200).send("OK - Bot is Live"));

// ==========================================
// 1. TELEGRAF BOT ENGINE
// ==========================================
const bot = new Telegraf(BOT_TOKEN);
let chatSettingsCache = {};

async function getChatSettings(chatId) {
    if (chatSettingsCache[chatId]) return chatSettingsCache[chatId];
    try {
        const snap = await db.ref(`groups/${chatId}/settings`).once('value');
        const settings = snap.val() || {
            welcome: { enabled: true, text: "Welcome {user}!" },
            antiLink: { enabled: false },
            antiForward: { enabled: false },
            badWords: { enabled: false, words: [], action: 'delete' },
            warnLimit: 3,
            chatLocked: false
        };
        chatSettingsCache[chatId] = settings;
        return settings;
    } catch (e) {
        return {};
    }
}

// RTDB Realtime Cache Refresh
db.ref('groups').on('child_changed', (snap) => {
    const val = snap.val();
    if (val && val.settings) chatSettingsCache[snap.key] = val.settings;
});

// Welcome New Users
bot.on('new_chat_members', async (ctx) => {
    try {
        const chatId = ctx.chat.id;
        const settings = await getChatSettings(chatId);
        if (!settings.welcome?.enabled) return;

        for (const member of ctx.message.new_chat_members) {
            if (member.is_bot) continue;
            const msg = (settings.welcome.text || "Welcome {user}!")
                .replace('{user}', member.first_name)
                .replace('{chat}', ctx.chat.title);
            ctx.reply(msg).catch(() => {});
        }
    } catch (err) {}
});

// Security Moderation
bot.on('message', async (ctx, next) => {
    try {
        if (!ctx.chat || ctx.chat.type === 'private') return next();

        const chatId = ctx.chat.id;
        const userId = ctx.from?.id;
        const text = ctx.message.text || ctx.message.caption || "";
        const settings = await getChatSettings(chatId);

        // Check if user is admin
        try {
            const member = await ctx.getChatMember(userId);
            if (['creator', 'administrator'].includes(member.status)) return next();
        } catch (e) {
            return next();
        }

        // 1. Lock Chat Check
        if (settings.chatLocked) {
            await ctx.deleteMessage().catch(() => {});
            return;
        }

        // 2. Anti-Forward Check
        if (settings.antiForward?.enabled && (ctx.message.forward_date || ctx.message.forward_origin)) {
            await ctx.deleteMessage().catch(() => {});
            return;
        }

        // 3. Anti-Link Check
        if (settings.antiLink?.enabled) {
            const linkRegex = /(https?:\/\/[^\s]+)|(t\.me\/[^\s]+)|(telegram\.me\/[^\s]+)/gi;
            if (linkRegex.test(text)) {
                await ctx.deleteMessage().catch(() => {});
                return;
            }
        }

        // 4. Bad Words Filter
        if (settings.badWords?.enabled && Array.isArray(settings.badWords.words)) {
            const foundBadWord = settings.badWords.words.some(word => 
                word.trim() && text.toLowerCase().includes(word.trim().toLowerCase())
            );

            if (foundBadWord) {
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
                        ctx.reply(`🚨 @${ctx.from.username || ctx.from.first_name} কে ব্যান করা হলো!`);
                    } else {
                        ctx.reply(`⚠️ [${ctx.from.first_name}] নিষিদ্ধ শব্দ ব্যবহার করায় ওয়ার্নিং দেওয়া হলো (${warns}/${settings.warnLimit || 3})`);
                    }
                } else if (action === 'ban') {
                    await ctx.banChatMember(userId).catch(() => {});
                }
                return;
            }
        }
    } catch (e) {}

    return next();
});

// ==========================================
// 2. GRAMJS (MTPROTO) API ENDPOINTS
// ==========================================
const tempAuthClients = {};

app.post('/api/tg/send-code', async (req, res) => {
    const { phone } = req.body;
    try {
        const client = new TelegramClient(new StringSession(""), API_ID, API_HASH, { connectionRetries: 5 });
        await client.connect();
        const { phoneCodeHash } = await client.sendCode({ apiId: API_ID, apiHash: API_HASH }, phone);
        tempAuthClients[phone] = { client, phoneCodeHash };
        res.json({ success: true, phoneCodeHash });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/tg/verify-code', async (req, res) => {
    const { phone, code, phoneCodeHash } = req.body;
    try {
        const sessionData = tempAuthClients[phone];
        if (!sessionData) throw new Error("সেশন পাওয়া যায়নি! পুনরায় ফোন নম্বর দিন।");

        const client = sessionData.client;
        await client.signInUser({ apiId: API_ID, apiHash: API_HASH }, {
            phoneNumber: phone,
            phoneCodeHash: phoneCodeHash || sessionData.phoneCodeHash,
            phoneCode: code,
        });

        const stringSession = client.session.save();
        const dialogs = await client.getDialogs();
        
        const adminGroups = dialogs
            .filter(d => d.isGroup || d.isChannel)
            .map(d => ({
                id: d.id.toString(),
                title: d.title,
                membersCount: d.entity?.participantsCount || 0
            }));

        res.json({ success: true, session: stringSession, groups: adminGroups });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/tg/connect-group', async (req, res) => {
    const { session, chatId } = req.body;
    try {
        const client = new TelegramClient(new StringSession(session), API_ID, API_HASH, {});
        await client.connect();

        const botEntity = await client.getEntity(BOT_TOKEN.split(':')[0]);
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

// Fallback Route for SPA
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ==========================================
// 3. START SERVER FIRST, THEN BOT
// ==========================================
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Web Dashboard is running live on port ${PORT}`);
    
    // Launch Telegram bot safely without crashing the web process
    bot.launch()
        .then(() => console.log("Telegram Bot Engine is Active!"))
        .catch(err => console.error("Telegraf Launch Error (Non-Fatal):", err.message));
});

// Graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
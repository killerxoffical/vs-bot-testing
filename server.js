const express = require('express');
const cors = require('cors');
const { Telegraf, Markup } = require('telegraf');
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
            welcome: { enabled: true, photoUrl: "", text: "👋 Welcome {user} to {chat}! Please adhere to our guidelines.", buttons: [], autoDeleteSeconds: 0 },
            banSystem: { enabled: true, msg: "⛔ {user} has been permanently removed from {chat}." },
            antiLink: { enabled: false, silent: false, msg: "⚠️ {user}, external links are restricted in this community!" },
            antiForward: { enabled: false, silent: false, msg: "⚠️ {user}, forwarded messages from foreign channels are not permitted!" },
            antiButton: { enabled: false, msg: "⚠️ {user}, messages with embedded url buttons are prohibited!" },
            emojiSpam: { enabled: false, maxCount: 2, silent: false, msg: "⚠️ {user}, excessive emojis are prohibited!", autoDeleteSeconds: 5 },
            badWords: { enabled: false, words: [], action: 'delete', customMsg: "⚠️ {user}, inappropriate language is prohibited! Warnings: ({warns}/{warn_limit})", autoDeleteSeconds: 6 },
            scammerAlert: { enabled: true, msg: "🚨 *SECURITY ALERT: This user has been flagged as a FRAUDSTER/SCAMMER by administrators! Do not conduct business with them.*" },
            nameTracker: { enabled: true },
            leaveTracker: { enabled: true },
            commands: { bio: { enabled: true, role: 'all' } },
            autoReplies: {},
            warnLimit: 3,
            chatLocked: false,
            lockMsg: "🔒 *This conversation has been temporarily muted by community administrators.*"
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

// Regex to detect Unicode & Extended Emojis
function countEmojis(str) {
    if (!str) return 0;
    const emojiRegex = /[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}\u{1F926}-\u{1F939}\u{1F1E6}-\u{1F1FF}]/gu;
    const matches = str.match(emojiRegex);
    return matches ? matches.length : 0;
}

// 1. WELCOME NEW MEMBERS
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
                setTimeout(() => {
                    ctx.deleteMessage(sentWelcome.message_id).catch(() => {});
                }, deleteSec * 1000);
            }
        }
    } catch (err) {}
});

// 2. MEMBER LEFT TRACKER
bot.on('left_chat_member', async (ctx) => {
    try {
        const chatId = ctx.chat.id;
        const user = ctx.message.left_chat_member;
        if (!user || user.is_bot) return;

        const leftData = {
            id: user.id.toString(),
            name: `${user.first_name || ''} ${user.last_name || ''}`.trim() || 'Unknown User',
            username: user.username ? `@${user.username}` : 'No username',
            timestamp: Date.now()
        };

        await db.ref(`groups/${chatId}/left_members/${user.id}`).set(leftData);

        const ownerSnap = await db.ref(`groups/${chatId}/merged_owner`).once('value');
        const ownerTelegramId = ownerSnap.val();
        if (ownerTelegramId) {
            try {
                await bot.telegram.sendMessage(
                    ownerTelegramId,
                    `🚪 *[MEMBER DEPARTURE ALERT]*\n\n` +
                    `• *Community:* ${ctx.chat.title}\n` +
                    `• *Member:* ${leftData.name} (${leftData.username})\n` +
                    `• *User ID:* \`${leftData.id}\`\n` +
                    `• *Event Time:* ${new Date().toLocaleString()}`,
                    { parse_mode: 'Markdown' }
                );
            } catch (err) {}
        }
    } catch (e) {}
});

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

// 3. CORE MODERATION & SHIELD ENGINE
bot.on('message', async (ctx, next) => {
    try {
        if (!ctx.chat || ctx.chat.type === 'private') return next();

        const chatId = ctx.chat.id;
        const userId = ctx.from?.id;
        const text = ctx.message.text || ctx.message.caption || "";
        const settings = await getChatSettings(chatId);
        const userRole = await getUserRole(ctx, userId);
        const isAdmin = ['owner', 'admin'].includes(userRole);

        // Name Change Tracker
        if (settings.nameTracker?.enabled !== false && ctx.from) {
            const currentFullName = `${ctx.from.first_name || ''} ${ctx.from.last_name || ''}`.trim() || ctx.from.first_name;
            const userHistoryRef = db.ref(`groups/${chatId}/name_history/${userId}`);
            
            const snap = await userHistoryRef.once('value');
            const storedName = snap.val();

            if (storedName && storedName !== currentFullName) {
                ctx.replyWithMarkdown(
                    `📝 *[SECURITY: NAME CHANGE DETECTED]*\n` +
                    `Member: [${currentFullName}](tg://user?id=${userId})\n` +
                    `🔄 *Previous Name:* \`${storedName}\`\n` +
                    `✨ *Updated Name:* \`${currentFullName}\``
                ).catch(() => {});
            }
            await userHistoryRef.set(currentFullName);
        }

        // Scammer Tagging
        const scammerSnap = await db.ref(`groups/${chatId}/scammers/${userId}`).once('value');
        if (scammerSnap.val()) {
            const scamNotice = settings.scammerAlert?.msg || "🚨 *SECURITY ALERT: This user has been flagged as a FRAUDSTER/SCAMMER by administrators!*";
            ctx.replyWithMarkdown(scamNotice, { reply_to_message_id: ctx.message.message_id }).catch(() => {});
        }

        // Auto-Reply Engine with Inline Button Support
        if (text && settings.autoReplies && typeof settings.autoReplies === 'object') {
            const cleanText = text.trim().toLowerCase();
            const replyKeys = Object.keys(settings.autoReplies);

            for (const key of replyKeys) {
                const rule = settings.autoReplies[key];
                if (!rule || !rule.trigger || !rule.response) continue;

                const triggerWord = rule.trigger.trim().toLowerCase();
                if (cleanText === triggerWord || cleanText.includes(triggerWord)) {
                    const target = rule.target || 'everyone';
                    let allowed = false;

                    if (target === 'everyone') allowed = true;
                    else if (target === 'admin_owner' && (userRole === 'admin' || userRole === 'owner')) allowed = true;
                    else if (target === 'owner_only' && userRole === 'owner') allowed = true;

                    if (allowed) {
                        const userMention = `[${ctx.from.first_name}](tg://user?id=${userId})`;
                        const formattedReply = rule.response
                            .replace(/{user}/g, userMention)
                            .replace(/{chat}/g, ctx.chat.title || "Community");

                        const keyboard = buildInlineButtons(rule.buttons);
                        const extra = { reply_to_message_id: ctx.message.message_id, parse_mode: 'Markdown' };
                        if (keyboard) extra.reply_markup = keyboard.reply_markup;

                        ctx.reply(formattedReply, extra).catch(async () => {
                            await ctx.reply(formattedReply, { reply_to_message_id: ctx.message.message_id }).catch(() => {});
                        });
                        break;
                    }
                }
            }
        }

        // Commands (/bio, /scam, /unscam, /ban)
        if (text.startsWith('/')) {
            const parts = text.trim().split(/\s+/);
            const cmd = parts[0].toLowerCase().replace(`@${bot.botInfo?.username?.toLowerCase()}`, '');

            if (cmd === '/ban' && isAdmin) {
                let targetUser = ctx.message.reply_to_message?.from;
                if (!targetUser) return ctx.reply("⚠️ Reply to a message with `/ban` to execute removal.");

                await ctx.banChatMember(targetUser.id).catch(() => {});
                const banNotice = (settings.banSystem?.msg || "⛔ {user} has been permanently removed from {chat}.")
                    .replace(/{user}/g, `[${targetUser.first_name}](tg://user?id=${targetUser.id})`)
                    .replace(/{chat}/g, ctx.chat.title)
                    .replace(/{admin}/g, ctx.from.first_name);

                return ctx.replyWithMarkdown(banNotice);
            }

            if (cmd === '/bio') {
                const bioRoleAllowed = settings.commands?.bio?.role || 'all';
                if (bioRoleAllowed === 'owner' && userRole !== 'owner') return;
                if (bioRoleAllowed === 'admin' && !isAdmin) return;

                let targetUser = ctx.from;
                if (ctx.message.reply_to_message && ctx.message.reply_to_message.from) {
                    targetUser = ctx.message.reply_to_message.from;
                }

                const targetId = targetUser.id;
                const targetFullName = `${targetUser.first_name || ''} ${targetUser.last_name || ''}`.trim() || targetUser.first_name;
                const targetRole = await getUserRole(ctx, targetId);

                const warnSnap = await db.ref(`groups/${chatId}/warns/${targetId}`).once('value');
                const warnsCount = warnSnap.val() || 0;
                const isScammer = (await db.ref(`groups/${chatId}/scammers/${targetId}`).once('value')).val();

                const bioMessage = 
                    `📋 *User Community Bio & Security Dossier*\n\n` +
                    `👤 *Name:* [${targetFullName}](tg://user?id=${targetId})\n` +
                    `🆔 *User ID:* \`${targetId}\`\n` +
                    `🔗 *Username:* ${targetUser.username ? `@${targetUser.username}` : '_None_'}\n` +
                    `🎖 *Assigned Role:* \`${targetRole.toUpperCase()}\`\n` +
                    `⚠️ *Active Infractions:* \`${warnsCount}/${settings.warnLimit || 3}\`\n` +
                    `🛡 *Trust Evaluation:* ${isScammer ? '🚨 *CONFIRMED SCAMMER*' : '✅ *Verified Safe*'}`;

                return ctx.replyWithMarkdown(bioMessage, { reply_to_message_id: ctx.message.message_id });
            }

            if (cmd === '/scam' && isAdmin) {
                let targetUser = ctx.message.reply_to_message?.from;
                if (!targetUser) return ctx.reply("⚠️ Reply to a message with `/scam` to flag this account.");

                await db.ref(`groups/${chatId}/scammers/${targetUser.id}`).set({
                    name: `${targetUser.first_name || ''} ${targetUser.last_name || ''}`.trim(),
                    username: targetUser.username || '',
                    flaggedAt: Date.now(),
                    flaggedBy: ctx.from.id
                });

                return ctx.replyWithMarkdown(`🚨 [${targetUser.first_name}](tg://user?id=${targetUser.id}) has been added to the **Scammer Blacklist**!`);
            }

            if (cmd === '/unscam' && isAdmin) {
                let targetUser = ctx.message.reply_to_message?.from;
                if (!targetUser) return ctx.reply("⚠️ Reply with `/unscam` to clear flags.");

                await db.ref(`groups/${chatId}/scammers/${targetUser.id}`).remove();
                return ctx.replyWithMarkdown(`✅ Scam designation cleared for [${targetUser.first_name}](tg://user?id=${targetUser.id}).`);
            }
        }

        if (isAdmin) return next();

        const userMention = `[${ctx.from.first_name}](tg://user?id=${userId})`;

        // Chat Lock Check
        if (settings.chatLocked) {
            await ctx.deleteMessage().catch(() => {});
            return;
        }

        // Anti-Bot / Anti-Inline Button Messages Block (New Feature)
        if (settings.antiButton?.enabled) {
            const hasReplyMarkup = ctx.message.reply_markup && ctx.message.reply_markup.inline_keyboard && ctx.message.reply_markup.inline_keyboard.length > 0;
            if (hasReplyMarkup || ctx.from.is_bot) {
                await ctx.deleteMessage().catch(() => {});
                if (settings.antiButton.msg) {
                    const response = settings.antiButton.msg.replace(/{user}/g, userMention).replace(/{chat}/g, ctx.chat.title);
                    ctx.replyWithMarkdown(response).then(m => setTimeout(() => ctx.deleteMessage(m.message_id).catch(() => {}), 5000));
                }
                return;
            }
        }

        // Emoji Spam Guard (New Feature)
        if (settings.emojiSpam?.enabled) {
            const emojiCount = countEmojis(text);
            const maxAllowed = parseInt(settings.emojiSpam.maxCount ?? 2);

            if (emojiCount > maxAllowed) {
                await ctx.deleteMessage().catch(() => {});
                if (!settings.emojiSpam.silent && settings.emojiSpam.msg) {
                    const response = settings.emojiSpam.msg
                        .replace(/{user}/g, userMention)
                        .replace(/{chat}/g, ctx.chat.title)
                        .replace(/{count}/g, emojiCount)
                        .replace(/{limit}/g, maxAllowed);
                    
                    const sentWarn = await ctx.replyWithMarkdown(response).catch(() => {});
                    const delSec = parseInt(settings.emojiSpam.autoDeleteSeconds || 5);
                    if (delSec > 0 && sentWarn && sentWarn.message_id) {
                        setTimeout(() => ctx.deleteMessage(sentWarn.message_id).catch(() => {}), delSec * 1000);
                    }
                }
                return;
            }
        }

        // Anti-Forward Check
        if (settings.antiForward?.enabled && (ctx.message.forward_date || ctx.message.forward_origin)) {
            await ctx.deleteMessage().catch(() => {});
            if (!settings.antiForward.silent && settings.antiForward.msg) {
                const response = settings.antiForward.msg.replace(/{user}/g, userMention).replace(/{chat}/g, ctx.chat.title);
                ctx.replyWithMarkdown(response).then(m => setTimeout(() => ctx.deleteMessage(m.message_id).catch(() => {}), 5000));
            }
            return;
        }

        // Anti-Link Check
        if (settings.antiLink?.enabled) {
            const linkRegex = /(https?:\/\/[^\s]+)|(t\.me\/[^\s]+)|(telegram\.me\/[^\s]+)/gi;
            if (linkRegex.test(text)) {
                await ctx.deleteMessage().catch(() => {});
                if (!settings.antiLink.silent && settings.antiLink.msg) {
                    const response = settings.antiLink.msg.replace(/{user}/g, userMention).replace(/{chat}/g, ctx.chat.title);
                    ctx.replyWithMarkdown(response).then(m => setTimeout(() => ctx.deleteMessage(m.message_id).catch(() => {}), 5000));
                }
                return;
            }
        }

        // Bad Words Filter
        if (settings.badWords?.enabled && Array.isArray(settings.badWords.words)) {
            const foundBadWord = settings.badWords.words.some(word => 
                word.trim() && text.toLowerCase().includes(word.trim().toLowerCase())
            );

            if (foundBadWord) {
                await ctx.deleteMessage().catch(() => {});
                const action = settings.badWords.action || 'delete';
                const warnLimit = settings.warnLimit || 3;
                let warningMsgSent = null;

                if (action === 'warn') {
                    const warnRef = db.ref(`groups/${chatId}/warns/${userId}`);
                    const snap = await warnRef.once('value');
                    const warns = (snap.val() || 0) + 1;
                    await warnRef.set(warns);

                    if (warns >= warnLimit) {
                        await ctx.banChatMember(userId).catch(() => {});
                        await warnRef.remove();
                        const banMsg = (settings.banSystem?.msg || "⛔ {user} has been permanently removed from {chat}.")
                            .replace(/{user}/g, `@${ctx.from.username || ctx.from.first_name}`)
                            .replace(/{chat}/g, ctx.chat.title);
                        warningMsgSent = await ctx.replyWithMarkdown(banMsg).catch(() => {});
                    } else {
                        const template = settings.badWords.customMsg || "⚠️ {user}, inappropriate language is prohibited! Warnings: ({warns}/{warn_limit})";
                        const customNotice = template
                            .replace(/{user}/g, userMention)
                            .replace(/{chat}/g, ctx.chat.title)
                            .replace(/{warns}/g, warns)
                            .replace(/{warn_limit}/g, warnLimit);
                        warningMsgSent = await ctx.replyWithMarkdown(customNotice).catch(() => {});
                    }
                } else if (action === 'ban') {
                    await ctx.banChatMember(userId).catch(() => {});
                    const banMsg = (settings.banSystem?.msg || "⛔ {user} has been permanently removed from {chat}.")
                        .replace(/{user}/g, userMention)
                        .replace(/{chat}/g, ctx.chat.title);
                    warningMsgSent = await ctx.replyWithMarkdown(banMsg).catch(() => {});
                }

                const deleteSec = parseInt(settings.badWords.autoDeleteSeconds || 0);
                if (deleteSec > 0 && warningMsgSent && warningMsgSent.message_id) {
                    setTimeout(() => {
                        ctx.deleteMessage(warningMsgSent.message_id).catch(() => {});
                    }, deleteSec * 1000);
                }
                return;
            }
        }
    } catch (e) {}
    return next();
});

// =============================================================================
// GRAMJS MTPROTO & REST APIS
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

        try {
            const me = await client.getMe();
            if (me && me.id) {
                await db.ref(`telegram_users/${phone.replace(/[^0-9]/g, '')}`).set(me.id.toString());
            }
        } catch (mErr) {}

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

        try {
            const me = await client.getMe();
            if (me && me.id) {
                await db.ref(`groups/${chatId}/merged_owner`).set(me.id.toString());
            }
        } catch (e) {}

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

// Live Community Broadcast with Buttons
app.post('/api/tg/broadcast', async (req, res) => {
    const { chatId, text, photoUrl, buttons } = req.body;
    try {
        if (!text && !photoUrl) throw new Error("Message content or image required");

        const keyboard = buildInlineButtons(buttons);
        const extra = { parse_mode: 'Markdown' };
        if (keyboard) extra.reply_markup = keyboard.reply_markup;

        const validPhoto = (photoUrl || "").trim();
        if (validPhoto && (validPhoto.startsWith('http://') || validPhoto.startsWith('https://'))) {
            await bot.telegram.sendPhoto(chatId, validPhoto, { caption: text || "", ...extra });
        } else {
            await bot.telegram.sendMessage(chatId, text, extra);
        }

        res.json({ success: true, message: "Announcement broadcasted successfully to the group!" });
    } catch (e) {
        res.status(500).json({ error: e.message || "Failed to send broadcast announcement" });
    }
});

// Individual Section Save
app.post('/api/tg/save-section', async (req, res) => {
    const { chatId, sectionKey, data } = req.body;
    try {
        if (!chatId || !sectionKey) throw new Error("Missing parameters");
        await db.ref(`groups/${chatId}/settings/${sectionKey}`).set(data);
        if (chatSettingsCache[chatId]) {
            chatSettingsCache[chatId][sectionKey] = data;
        }
        res.json({ success: true, message: "Section policy saved successfully!" });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Test Welcome
app.post('/api/tg/test-welcome', async (req, res) => {
    const { chatId, photoUrl, text, buttons, autoDeleteSeconds } = req.body;
    try {
        const testUser = `[Admin (Test)](tg://user?id=${botId || 0})`;
        const chatInfo = await bot.telegram.getChat(chatId).catch(() => ({ title: "Community" }));
        const formatted = (text || "Welcome {user} to {chat}!")
            .replace(/{user}/g, testUser)
            .replace(/{chat}/g, chatInfo.title);

        const keyboard = buildInlineButtons(buttons);
        const extra = { parse_mode: 'Markdown' };
        if (keyboard) extra.reply_markup = keyboard.reply_markup;

        let sentMsg;
        const validPhoto = (photoUrl || "").trim();

        if (validPhoto && (validPhoto.startsWith('http://') || validPhoto.startsWith('https://'))) {
            sentMsg = await bot.telegram.sendPhoto(chatId, validPhoto, {
                caption: `🧪 *[TEST WELCOME MESSAGE]*\n\n${formatted}`,
                ...extra
            }).catch(async () => {
                return await bot.telegram.sendMessage(chatId, `🧪 *[TEST WELCOME MESSAGE]*\n\n${formatted}`, extra);
            });
        } else {
            sentMsg = await bot.telegram.sendMessage(chatId, `🧪 *[TEST WELCOME MESSAGE]*\n\n${formatted}`, extra);
        }

        const sec = parseInt(autoDeleteSeconds || 0);
        if (sec > 0 && sentMsg && sentMsg.message_id) {
            setTimeout(() => {
                bot.telegram.deleteMessage(chatId, sentMsg.message_id).catch(() => {});
            }, sec * 1000);
        }

        res.json({ success: true, message: `Test welcome delivered! ${sec > 0 ? `(Auto-deletes in ${sec}s)` : ''}` });
    } catch (e) {
        res.status(500).json({ error: e.message || "Failed to send test message." });
    }
});

// Announce Lock
app.post('/api/tg/announce-lock', async (req, res) => {
    const { chatId, locked, message } = req.body;
    try {
        const defaultMsg = locked 
            ? "🔒 *This conversation has been temporarily muted by community administrators.*" 
            : "🔓 *Conversation restriction lifted. Members may now post messages.*";
        const broadcast = message && message.trim() ? message.trim() : defaultMsg;

        await bot.telegram.sendMessage(chatId, broadcast, { parse_mode: 'Markdown' });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Get Left Members
app.post('/api/tg/get-left-members', async (req, res) => {
    const { chatId } = req.body;
    try {
        const snap = await db.ref(`groups/${chatId}/left_members`).once('value');
        const data = snap.val() || {};
        const list = Object.keys(data).map(uid => ({
            id: uid,
            ...data[uid]
        })).sort((a,b) => b.timestamp - a.timestamp);
        res.json({ success: true, leftMembers: list });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Get Scammers List
app.post('/api/tg/get-scammers', async (req, res) => {
    const { chatId } = req.body;
    try {
        const snap = await db.ref(`groups/${chatId}/scammers`).once('value');
        const data = snap.val() || {};
        const list = Object.keys(data).map(uid => ({
            id: uid,
            ...data[uid]
        }));
        res.json({ success: true, scammers: list });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Fallback Route
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

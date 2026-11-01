const express = require('express');
const cors = require('cors');
const { Telegraf, Markup } = require('telegraf');
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { computeCheck } = require('telegram/Password');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

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

// Bot & Telegram Credentials
const BOT_TOKEN = process.env.BOT_TOKEN || "8590481969:AAFy2RiubtlGSLOHIwR_I8f5XJVtjL5V0u4";
let BOT_USERNAME = "Vareonprotection_bot";
const API_ID = parseInt(process.env.API_ID || "39447470");
const API_HASH = process.env.API_HASH || "eb7cac1c8ad9935d4b208dc0da076d8c";
const PORT = process.env.PORT || 3000;

const app = express();
app.use(cors());
app.use(express.json());

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname));

app.get('/ping', (req, res) => res.status(200).send("OK - Infinity Guard Engine Active"));

// Admin Route
app.get('/admin', (req, res) => {
    const p1 = path.join(__dirname, 'public', 'admin.html');
    const p2 = path.join(__dirname, 'admin.html');
    if (fs.existsSync(p1)) return res.sendFile(p1);
    if (fs.existsSync(p2)) return res.sendFile(p2);
    res.status(404).send("<h2>admin.html not found.</h2>");
});

// Helper: Normalize Telegram Chat ID
function normalizeChatId(rawId) {
    if (!rawId) return "";
    let s = rawId.toString().trim();
    if (s.startsWith('-100')) return s;
    if (s.startsWith('-')) {
        let digits = s.substring(1);
        if (digits.length >= 9) return `-100${digits}`;
        return s;
    }
    return `-100${s}`;
}

// Time Duration Parser
function parseDuration(str) {
    if (!str) return null;
    const match = str.trim().match(/^(\d+)([smhdw]?)$/i);
    if (!match) return null;
    const val = parseInt(match[1]);
    const unit = (match[2] || 'm').toLowerCase();

    switch (unit) {
        case 's': return { seconds: val, text: `${val} second(s)` };
        case 'm': return { seconds: val * 60, text: `${val} minute(s)` };
        case 'h': return { seconds: val * 3600, text: `${val} hour(s)` };
        case 'd': return { seconds: val * 86400, text: `${val} day(s)` };
        case 'w': return { seconds: val * 604800, text: `${val} week(s)` };
        default: return { seconds: val * 60, text: `${val} minute(s)` };
    }
}

// =============================================================================
// SUBSCRIPTION CHECKER WITH AUTO-RECOVERY & QUOTA ENFORCEMENT
// =============================================================================
let subscriptionCache = {};

async function isChatSubscriptionActive(rawChatId, ctx = null) {
    const chatId = normalizeChatId(rawChatId);
    const now = Date.now();

    if (subscriptionCache[chatId] && (now - subscriptionCache[chatId].cachedAt < 20000)) {
        return subscriptionCache[chatId].isActive;
    }

    try {
        let ownerSnap = await db.ref(`groups/${chatId}/merged_owner`).once('value');
        let ownerTgId = ownerSnap.val();

        if (!ownerTgId) {
            let unNormSnap = await db.ref(`groups/${rawChatId}/merged_owner`).once('value');
            ownerTgId = unNormSnap.val();
            if (ownerTgId) {
                await db.ref(`groups/${chatId}/merged_owner`).set(ownerTgId);
            }
        }

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
            const subKeys = Object.keys(allSubs);
            for (const k of subKeys) {
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

async function getOwnerSubByChat(rawChatId) {
    const active = await isChatSubscriptionActive(rawChatId);
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
    console.log(`[Infinity Guard] Telegraf Online: @${BOT_USERNAME} (ID: ${botId})`);
}).catch(err => {
    console.error("[Infinity Guard] BOT TOKEN ERROR:", err.message);
});

async function getChatSettings(rawChatId) {
    const chatId = normalizeChatId(rawChatId);
    if (chatSettingsCache[chatId]) return chatSettingsCache[chatId];

    try {
        let snap = await db.ref(`groups/${chatId}/settings`).once('value');
        let settings = snap.val();

        if (!settings) {
            let legacySnap = await db.ref(`groups/${rawChatId}/settings`).once('value');
            settings = legacySnap.val();
            if (settings) {
                await db.ref(`groups/${chatId}/settings`).set(settings);
            }
        }

        const defaultSettings = {
            welcome: { enabled: true, photoUrl: "", text: "👋 Welcome {mention} to {chat}! Please adhere to our guidelines.", buttons: [], autoDeleteSeconds: 0 },
            goodbye: { enabled: true, text: "👋 Goodbye {mention}! We hope to see you again soon in {chat}.", autoDeleteSeconds: 10 },
            banSystem: { enabled: true, silent: false, msg: "⛔ {name} has been permanently removed from {chat}." },
            
            emojiSpam: { enabled: false, maxCount: 2, action: 'delete', silent: false, msg: "⚠️ {mention}, excessive emojis are prohibited ({count}/{limit})! Strike: ({warns}/{warn_limit})", autoDeleteSeconds: 5 },
            antiLink: { enabled: false, action: 'delete', silent: false, whitelist: [], msg: "⚠️ {mention}, external links are restricted in this community! Strike: ({warns}/{warn_limit})", autoDeleteSeconds: 5 },
            antiForward: { enabled: false, action: 'delete', silent: false, msg: "⚠️ {mention}, forwarded posts are not allowed in {chat}! Strikes: ({warns}/{warn_limit})", autoDeleteSeconds: 5 },
            antiButton: { enabled: false, action: 'delete', silent: false, msg: "⚠️ {mention}, inline button spam is strictly prohibited in {chat}!", autoDeleteSeconds: 5 },
            
            badWords: { enabled: false, words: [], action: 'delete', silent: false, customMsg: "⚠️ {mention}, inappropriate language is prohibited! Strike: ({warns}/{warn_limit})", autoDeleteSeconds: 6 },
            
            scammerAlert: { enabled: true, msg: "🚨 *SECURITY ALERT: {mention} is a CONFIRMED SCAMMER flagged by community administrators! Do not transact with this user.*" },
            nameTracker: { enabled: true },
            leaveTracker: { enabled: true },
            commands: { bio: { enabled: true, role: 'all' } },
            customCommands: {},
            autoReplies: {},
            
            warnLimit: 3,
            warnAction: 'ban',
            
            chatLocked: false,
            lockMsg: "🔒 *This conversation has been temporarily muted by community administrators.*"
        };

        const merged = Object.assign({}, defaultSettings, settings || {});
        chatSettingsCache[chatId] = merged;
        return merged;
    } catch (e) {
        return {};
    }
}

db.ref('groups').on('child_changed', (snap) => {
    const val = snap.val();
    const normalizedKey = normalizeChatId(snap.key);
    if (val && val.settings) {
        chatSettingsCache[normalizedKey] = val.settings;
    }
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

function countEmojis(message) {
    let count = 0;
    const text = message.text || message.caption || "";

    const emojiRegex = /[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}\u{1F926}-\u{1F939}\u{1F1E6}-\u{1F1FF}]/gu;
    const matches = text.match(emojiRegex);
    if (matches) count += matches.length;

    const entities = message.entities || message.caption_entities || [];
    for (const ent of entities) {
        if (ent.type === 'custom_emoji') count += 1;
    }

    return count;
}

function extractAllUrls(message) {
    const urls = [];
    const text = message.text || message.caption || "";
    const entities = message.entities || message.caption_entities || [];

    for (const ent of entities) {
        if (ent.type === 'url') {
            urls.push(text.substring(ent.offset, ent.offset + ent.length));
        } else if (ent.type === 'text_link' && ent.url) {
            urls.push(ent.url);
        }
    }

    const linkRegex = /(https?:\/\/[^\s]+)|(t\.me\/[^\s]+)|(telegram\.me\/[^\s]+)|([a-zA-Z0-9-]+\.[a-zA-Z]{2,}(?:\/[^\s]*)?)/gi;
    let match;
    while ((match = linkRegex.exec(text)) !== null) {
        urls.push(match[0]);
    }

    return urls;
}

function isLinkWhitelisted(urlStr, whitelistArray) {
    if (!Array.isArray(whitelistArray) || whitelistArray.length === 0) return false;
    const cleanUrl = urlStr.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '');
    return whitelistArray.some(domain => {
        const cleanDomain = domain.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').trim();
        return cleanDomain && cleanUrl.includes(cleanDomain);
    });
}

function formatTemplateMessage(template, ctx, extra = {}) {
    if (!template) return "";
    const fromUser = ctx.from || {};
    const fullName = `${fromUser.first_name || ''} ${fromUser.last_name || ''}`.trim() || fromUser.first_name || 'Member';
    const userMention = `[${fullName}](tg://user?id=${fromUser.id || 0})`;
    const usernameTag = fromUser.username ? `@${fromUser.username}` : fullName;
    const chatTitle = ctx.chat?.title || "Community";
    const userId = fromUser.id || "0";

    return template
        .replace(/{mention}/g, userMention)
        .replace(/{user}/g, userMention)
        .replace(/{name}/g, fullName)
        .replace(/{username}/g, usernameTag)
        .replace(/{id}/g, userId)
        .replace(/{chat}/g, chatTitle)
        .replace(/{warns}/g, extra.warns ?? '1')
        .replace(/{warn_limit}/g, extra.warn_limit ?? '3')
        .replace(/{count}/g, extra.count ?? '0')
        .replace(/{limit}/g, extra.limit ?? '0');
}

async function handleStrikePunishment(ctx, chatId, userId, settings, violationLabel) {
    const warnLimit = parseInt(settings.warnLimit || 3);
    const warnAction = settings.warnAction || 'ban';
    const warnRef = db.ref(`groups/${chatId}/warns/${userId}`);
    const snap = await warnRef.once('value');
    const currentWarns = (snap.val() || 0) + 1;

    const fromUser = ctx.from || {};
    const fullName = `${fromUser.first_name || ''} ${fromUser.last_name || ''}`.trim() || fromUser.first_name || 'Member';
    const userMention = `[${fullName}](tg://user?id=${userId})`;

    if (currentWarns >= warnLimit) {
        await warnRef.remove();
        if (warnAction === 'mute') {
            await ctx.restrictChatMember(userId, { permissions: { can_send_messages: false } }).catch(() => {});
            return ctx.replyWithMarkdown(`🔇 ${userMention} reached max infractions (\`${currentWarns}/${warnLimit}\`) for **${violationLabel}** and has been **muted**.`);
        } else if (warnAction === 'kick') {
            await ctx.banChatMember(userId).catch(() => {});
            await ctx.unbanChatMember(userId).catch(() => {});
            return ctx.replyWithMarkdown(`👢 ${userMention} reached max infractions (\`${currentWarns}/${warnLimit}\`) and has been **kicked**.`);
        } else {
            await ctx.banChatMember(userId).catch(() => {});
            return ctx.replyWithMarkdown(`⛔ ${userMention} reached max infractions (\`${currentWarns}/${warnLimit}\`) for **${violationLabel}** and has been **permanently banned**.`);
        }
    } else {
        await warnRef.set(currentWarns);
        return currentWarns;
    }
}

// =============================================================================
// TELEGRAM PRIVATE /START COMMAND (PROFESSIONAL PRESENTATION & PORTAL LINK)
// =============================================================================
bot.start(async (ctx) => {
    if (ctx.chat.type !== 'private') return;

    try {
        const portalUrlSnap = await db.ref('system/portal_url').once('value');
        const portalUrl = portalUrlSnap.val() || "https://infinityguard.cloud";

        const startMessage = 
            `🛡 *Welcome to Infinity Guard Enterprise Security Cloud!*\n\n` +
            `Infinity Guard is an autonomous, high-speed Telegram cyber-defense system engineered to protect high-traffic Groups & Broadcast Channels with granular policies and raid immunity.\n\n` +
            `✨ *Core Defensive Capabilities:*\n` +
            `• 🤖 *Anti-Button Bot Filter* (Blocks promotional userbots)\n` +
            `• 🔄 *Anti-Forward Shield* (Purges external forwards)\n` +
            `• 🔗 *External Link Whitelist* (Permits only verified URLs)\n` +
            `• 😀 *Emoji Spam Purge* with custom infractions & mute\n` +
            `• 🚨 *Scammer Blacklist* with automated warning banners\n` +
            `• 📝 *Profile Alteration Audit* & Deep Dossier (\`/bio\`)\n` +
            `• 📢 *Live Broadcast Studio* with photos & inline buttons\n\n` +
            `💎 *Official Subscription Tiers:*\n` +
            `• 🟢 *Starter (1 Chat):* ৳50 (~$0.39 USDT) / Month\n` +
            `• 🔵 *Growth (5 Chats):* ৳200 (~$1.57 USDT) / Month\n` +
            `• 🟣 *Pro Hub (15 Chats):* ৳450 (~$3.54 USDT) / Month\n` +
            `• 👑 *Infinity Enterprise (Unlimited):* ৳750 (~$5.90 USDT) / Month\n\n` +
            `👇 *Connect your communities and manage security via Cloud Console:*`;

        const keyboard = Markup.inlineKeyboard([
            [Markup.button.url("🌐 Access Infinity Guard Cloud", portalUrl)],
            [Markup.button.url("💬 Contact Admin @Blackmoney54", "https://t.me/Blackmoney54")]
        ]);

        return ctx.replyWithMarkdown(startMessage, keyboard);
    } catch (e) {
        return ctx.reply("Welcome to Infinity Guard!");
    }
});

// Welcome New Members
bot.on('new_chat_members', async (ctx) => {
    try {
        const chatId = normalizeChatId(ctx.chat.id);
        const isSubActive = await isChatSubscriptionActive(chatId, ctx);
        if (!isSubActive) return;

        const settings = await getChatSettings(chatId);
        if (!settings.welcome?.enabled) return;

        for (const member of ctx.message.new_chat_members) {
            if (member.is_bot) continue;

            const fullName = `${member.first_name || ''} ${member.last_name || ''}`.trim() || member.first_name;
            const userMention = `[${fullName}](tg://user?id=${member.id})`;
            const usernameTag = member.username ? `@${member.username}` : fullName;

            const msg = (settings.welcome.text || "Welcome {mention} to {chat}!")
                .replace(/{mention}/g, userMention)
                .replace(/{user}/g, userMention)
                .replace(/{name}/g, fullName)
                .replace(/{username}/g, usernameTag)
                .replace(/{id}/g, member.id)
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

// Member Left Tracker
bot.on('left_chat_member', async (ctx) => {
    try {
        const chatId = normalizeChatId(ctx.chat.id);
        const user = ctx.message.left_chat_member;
        if (!user || user.is_bot) return;

        const fullName = `${user.first_name || ''} ${user.last_name || ''}`.trim() || user.first_name;
        const userMention = `[${fullName}](tg://user?id=${user.id})`;
        const usernameTag = user.username ? `@${user.username}` : fullName;

        const leftData = {
            id: user.id.toString(),
            name: fullName,
            username: user.username ? `@${user.username}` : 'No username',
            timestamp: Date.now()
        };

        await db.ref(`groups/${chatId}/left_members/${user.id}`).set(leftData);

        const isSubActive = await isChatSubscriptionActive(chatId, ctx);
        if (!isSubActive) return;

        const settings = await getChatSettings(chatId);

        if (settings.goodbye?.enabled !== false && settings.goodbye?.text) {
            const goodbyeMsg = settings.goodbye.text
                .replace(/{mention}/g, userMention)
                .replace(/{user}/g, userMention)
                .replace(/{name}/g, fullName)
                .replace(/{username}/g, usernameTag)
                .replace(/{id}/g, user.id)
                .replace(/{chat}/g, ctx.chat.title || "Community");

            const sentGoodbye = await ctx.replyWithMarkdown(goodbyeMsg).catch(() => {});
            const delSec = parseInt(settings.goodbye.autoDeleteSeconds || 0);
            if (delSec > 0 && sentGoodbye && sentGoodbye.message_id) {
                setTimeout(() => ctx.deleteMessage(sentGoodbye.message_id).catch(() => {}), delSec * 1000);
            }
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

// Core Moderation, Slash Commands, Name Change Tracker & Scammer Auto-Warning
bot.on('message', async (ctx, next) => {
    try {
        if (!ctx.chat || ctx.chat.type === 'private') return next();

        const chatId = normalizeChatId(ctx.chat.id);
        const text = ctx.message.text || ctx.message.caption || "";

        if (text === '/ping') {
            return ctx.replyWithMarkdown(`🏓 *Pong!*\n🤖 Bot: @${BOT_USERNAME}\n⚡ Status: *Active & Guarding Community*`);
        }

        const isSubActive = await isChatSubscriptionActive(chatId, ctx);
        if (!isSubActive) {
            if (text.startsWith('/bio') || text.startsWith('/warn') || text.startsWith('/rules') || text.startsWith('/scam')) {
                return ctx.reply("⚠️ Infinity Guard Bot is inactive in this community because there is no active subscription license. Please claim a license from the dashboard.");
            }
            return next();
        }

        const userId = ctx.from?.id;
        const settings = await getChatSettings(chatId);
        const userRole = await getUserRole(ctx, userId);
        const isAdmin = ['owner', 'admin'].includes(userRole);

        const fullName = `${ctx.from?.first_name || ''} ${ctx.from?.last_name || ''}`.trim() || (ctx.from ? ctx.from.first_name : 'Member');
        const userMention = `[${fullName}](tg://user?id=${userId})`;
        const currentUsername = ctx.from?.username ? `@${ctx.from.username}` : '';
        const usernameTag = currentUsername || fullName;

        // Profile Alteration Tracker
        if (settings.nameTracker?.enabled !== false && ctx.from && userId) {
            const userHistoryRef = db.ref(`groups/${chatId}/name_history/${userId}`);
            const snap = await userHistoryRef.once('value');
            const stored = snap.val();

            if (stored && stored.currentName) {
                const oldName = stored.currentName;
                const oldUsername = stored.currentUsername || '';

                const nameChanged = (oldName !== fullName);
                const usernameChanged = (oldUsername !== currentUsername);

                if (nameChanged || usernameChanged) {
                    let alertText = `🚨 *[SECURITY ALERT: PROFILE ALTERATION DETECTED]*\n👤 *Member:* ${userMention}\n`;
                    if (nameChanged) {
                        alertText += `🔄 *Previous Name:* \`${oldName}\` ➔ ✨ *New Name:* \`${fullName}\`\n`;
                    }
                    if (usernameChanged) {
                        alertText += `🔗 *Previous Username:* \`${oldUsername || 'None'}\` ➔ ✨ *New Username:* \`${currentUsername || 'None'}\`\n`;
                    }
                    alertText += `🕒 *Detected:* Just now`;

                    ctx.replyWithMarkdown(alertText, { reply_to_message_id: ctx.message.message_id }).catch(() => {});

                    await userHistoryRef.update({
                        currentName: fullName,
                        currentUsername: currentUsername,
                        previousName: oldName,
                        previousUsername: oldUsername,
                        lastChangedAt: Date.now()
                    });
                }
            } else {
                await userHistoryRef.set({
                    currentName: fullName,
                    currentUsername: currentUsername,
                    initialSeenAt: Date.now()
                });
            }
        }

        // Scammer Live Warning Automation
        const scammerSnap = await db.ref(`groups/${chatId}/scammers/${userId}`).once('value');
        if (scammerSnap.val()) {
            const defaultScamNotice = "🚨 *SECURITY ALERT: {mention} is a CONFIRMED SCAMMER flagged by community administrators! Do not transact with this user.*";
            const scamNoticeTemplate = settings.scammerAlert?.msg || defaultScamNotice;
            const formattedScamNotice = formatTemplateMessage(scamNoticeTemplate, ctx);

            ctx.replyWithMarkdown(formattedScamNotice, { reply_to_message_id: ctx.message.message_id }).catch(() => {});
        }

        // Auto-Reply Engine
        if (text && settings.autoReplies && !text.startsWith('/')) {
            const cleanText = text.trim().toLowerCase();
            const repliesObj = settings.autoReplies;
            const replyKeys = Object.keys(repliesObj);

            for (const key of replyKeys) {
                const rule = repliesObj[key];
                if (!rule || !rule.trigger || !rule.response) continue;

                const triggerWord = rule.trigger.trim().toLowerCase();
                const regex = new RegExp(`(^|\\s|[^a-zA-Z0-9])${triggerWord}($|\\s|[^a-zA-Z0-9])`, 'i');
                const isMatch = regex.test(cleanText) || cleanText === triggerWord;

                if (isMatch) {
                    const target = rule.target || 'everyone';
                    let allowed = false;

                    if (target === 'everyone') allowed = true;
                    else if (target === 'admin_owner' && isAdmin) allowed = true;
                    else if (target === 'owner_only' && userRole === 'owner') allowed = true;

                    if (allowed) {
                        const formattedReply = formatTemplateMessage(rule.response, ctx);
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

        // Slash Commands
        if (text.startsWith('/')) {
            const parts = text.trim().split(/\s+/);
            const cmd = parts[0].toLowerCase().replace(`@${BOT_USERNAME.toLowerCase()}`, '');
            const targetRepliedUser = ctx.message.reply_to_message?.from;

            // /bio
            if (cmd === '/bio') {
                const bioRoleAllowed = settings.commands?.bio?.role || 'all';
                if (bioRoleAllowed === 'owner' && userRole !== 'owner') return;
                if (bioRoleAllowed === 'admin' && !isAdmin) return;

                const targetUser = targetRepliedUser || ctx.from;
                const targetId = targetUser.id;
                const targetFullName = `${targetUser.first_name || ''} ${targetUser.last_name || ''}`.trim() || targetUser.first_name;
                const targetRole = await getUserRole(ctx, targetId);

                const warnSnap = await db.ref(`groups/${chatId}/warns/${targetId}`).once('value');
                const warnsCount = warnSnap.val() || 0;
                const isScammer = (await db.ref(`groups/${chatId}/scammers/${targetId}`).once('value')).val();

                const histSnap = await db.ref(`groups/${chatId}/name_history/${targetId}`).once('value');
                const histData = histSnap.val() || {};

                let alterationSection = "✅ *No alteration recorded.*";
                if (histData.lastChangedAt && histData.previousName) {
                    const changeDate = new Date(histData.lastChangedAt).toLocaleString();
                    alterationSection = 
                        `⚠️ *Alteration Recorded on:* \`${changeDate}\`\n` +
                        `🔄 *Previous Name:* \`${histData.previousName}\`\n` +
                        `🔗 *Previous Username:* \`${histData.previousUsername || 'None'}\``;
                }

                const bioMessage = 
                    `👤 *User Security Dossier — Infinity Guard*\n` +
                    `━━━━━━━━━━━━━━━━━━━━\n` +
                    `🏷 *Name:* [${targetFullName}](tg://user?id=${targetId})\n` +
                    `🆔 *User ID:* \`${targetId}\`\n` +
                    `🔗 *Username:* ${targetUser.username ? `@${targetUser.username}` : '_None_'}\n` +
                    `🎖 *Group Role:* \`${targetRole.toUpperCase()}\`\n` +
                    `⚠️ *Infractions / Warns:* \`${warnsCount}/${settings.warnLimit || 3}\`\n` +
                    `🛡 *Trust Score:* ${isScammer ? '🚨 *BLACKLISTED SCAMMER*' : '✅ *Verified Regular User*'}\n` +
                    `━━━━━━━━━━━━━━━━━━━━\n` +
                    `📝 *Profile History Audit:*\n${alterationSection}\n` +
                    `━━━━━━━━━━━━━━━━━━━━`;

                return ctx.replyWithMarkdown(bioMessage, { reply_to_message_id: ctx.message.message_id });
            }

            // /mute & /unmute
            if (cmd === '/mute' && isAdmin) {
                if (!targetRepliedUser) return ctx.reply("⚠️ Reply to a user's message with `/mute <duration>`. Example: `/mute 10m` or `/mute 1h`");
                if (targetRepliedUser.id === botId) return ctx.reply("❌ Cannot mute the guardian bot.");

                const durationArg = parts[1] || null;
                const durationObj = parseDuration(durationArg);

                try {
                    if (durationObj && durationObj.seconds > 30) {
                        const untilDate = Math.floor(Date.now() / 1000) + durationObj.seconds;
                        await ctx.restrictChatMember(targetRepliedUser.id, {
                            permissions: { can_send_messages: false },
                            until_date: untilDate
                        });
                        return ctx.replyWithMarkdown(`🔇 [${targetRepliedUser.first_name}](tg://user?id=${targetRepliedUser.id}) has been muted for **${durationObj.text}**.`);
                    } else {
                        await ctx.restrictChatMember(targetRepliedUser.id, {
                            permissions: { can_send_messages: false }
                        });
                        return ctx.replyWithMarkdown(`🔇 [${targetRepliedUser.first_name}](tg://user?id=${targetRepliedUser.id}) has been muted permanently.`);
                    }
                } catch (e) {
                    return ctx.reply(`❌ Failed to mute: ${e.message}`);
                }
            }

            if (cmd === '/unmute' && isAdmin) {
                if (!targetRepliedUser) return ctx.reply("⚠️ Reply to a user's message with `/unmute`.");
                await ctx.restrictChatMember(targetRepliedUser.id, {
                    permissions: {
                        can_send_messages: true,
                        can_send_media_messages: true,
                        can_send_other_messages: true,
                        can_add_web_page_previews: true
                    }
                }).catch(e => ctx.reply(`❌ Failed: ${e.message}`));
                return ctx.replyWithMarkdown(`🔊 [${targetRepliedUser.first_name}](tg://user?id=${targetRepliedUser.id}) has been unmuted.`);
            }

            // /ban & /unban
            if (cmd === '/ban' && isAdmin) {
                if (!targetRepliedUser) return ctx.reply("⚠️ Reply to a message with `/ban`.");
                await ctx.banChatMember(targetRepliedUser.id).catch(e => ctx.reply(`❌ Failed: ${e.message}`));
                return ctx.replyWithMarkdown(`⛔ [${targetRepliedUser.first_name}](tg://user?id=${targetRepliedUser.id}) has been permanently banned.`);
            }

            if (cmd === '/unban' && isAdmin) {
                if (!targetRepliedUser) return ctx.reply("⚠️ Reply with `/unban`.");
                await ctx.unbanChatMember(targetRepliedUser.id).catch(e => ctx.reply(`❌ Failed: ${e.message}`));
                return ctx.replyWithMarkdown(`✅ Ban lifted for [${targetRepliedUser.first_name}](tg://user?id=${targetRepliedUser.id}).`);
            }

            // /kick
            if (cmd === '/kick' && isAdmin) {
                if (!targetRepliedUser) return ctx.reply("⚠️ Reply to a message with `/kick`.");
                await ctx.banChatMember(targetRepliedUser.id).catch(() => {});
                await ctx.unbanChatMember(targetRepliedUser.id).catch(() => {});
                return ctx.replyWithMarkdown(`👢 [${targetRepliedUser.first_name}](tg://user?id=${targetRepliedUser.id}) has been kicked.`);
            }

            // /warn, /unwarn, /warns
            if (cmd === '/warn' && isAdmin) {
                if (!targetRepliedUser) return ctx.reply("⚠️ Reply to a user's message with `/warn`.");
                if (targetRepliedUser.id === botId) return ctx.reply("❌ Cannot warn the protection bot.");

                const res = await handleStrikePunishment(ctx, chatId, targetRepliedUser.id, settings, 'Manual Strike');
                if (typeof res === 'number') {
                    return ctx.replyWithMarkdown(`⚠️ Strike issued to [${targetRepliedUser.first_name}](tg://user?id=${targetRepliedUser.id})!\nInfractions: \`${res}/${settings.warnLimit || 3}\``);
                }
                return;
            }

            if ((cmd === '/unwarn' || cmd === '/resetwarns') && isAdmin) {
                if (!targetRepliedUser) return ctx.reply("⚠️ Reply to a user's message with `/unwarn`.");
                await db.ref(`groups/${chatId}/warns/${targetRepliedUser.id}`).remove();
                return ctx.replyWithMarkdown(`✅ Infraction strikes cleared for [${targetRepliedUser.first_name}](tg://user?id=${targetRepliedUser.id}).`);
            }

            if (cmd === '/warns') {
                const target = targetRepliedUser || ctx.from;
                const warnSnap = await db.ref(`groups/${chatId}/warns/${target.id}`).once('value');
                const count = warnSnap.val() || 0;
                return ctx.replyWithMarkdown(`⚠️ [${target.first_name}](tg://user?id=${target.id}) has \`${count}/${settings.warnLimit || 3}\` warnings.`);
            }

            // /scam, /scammer, /unscam, /unscammer
            if ((cmd === '/scam' || cmd === '/scammer') && isAdmin) {
                if (!targetRepliedUser) return ctx.reply("⚠️ Reply to a message with `/scam` or `/scammer`.");
                
                await db.ref(`groups/${chatId}/scammers/${targetRepliedUser.id}`).set({
                    name: `${targetRepliedUser.first_name || ''} ${targetRepliedUser.last_name || ''}`.trim(),
                    username: targetRepliedUser.username || '',
                    flaggedAt: Date.now(),
                    flaggedBy: ctx.from.id
                });
                return ctx.replyWithMarkdown(`🚨 [${targetRepliedUser.first_name}](tg://user?id=${targetRepliedUser.id}) has been added to the **Scammer Blacklist**!\n*All future messages will trigger security warnings.*`);
            }

            if ((cmd === '/unscam' || cmd === '/unscammer') && isAdmin) {
                if (!targetRepliedUser) return ctx.reply("⚠️ Reply with `/unscam` or `/unscammer`.");
                await db.ref(`groups/${chatId}/scammers/${targetRepliedUser.id}`).remove();
                return ctx.replyWithMarkdown(`✅ Scam tag cleared for [${targetRepliedUser.first_name}](tg://user?id=${targetRepliedUser.id}).`);
            }

            // /pin, /lock, /unlock
            if (cmd === '/pin' && isAdmin) {
                if (!ctx.message.reply_to_message) return ctx.reply("⚠️ Reply to a message with `/pin`.");
                await ctx.pinChatMessage(ctx.message.reply_to_message.message_id).catch(() => {});
                return ctx.reply("📌 Message pinned successfully.");
            }

            if (cmd === '/lock' && isAdmin) {
                settings.chatLocked = true;
                await db.ref(`groups/${chatId}/settings/chatLocked`).set(true);
                return ctx.replyWithMarkdown("🔒 *Chat has been locked. Regular members cannot send messages.*");
            }

            if (cmd === '/unlock' && isAdmin) {
                settings.chatLocked = false;
                await db.ref(`groups/${chatId}/settings/chatLocked`).set(false);
                return ctx.replyWithMarkdown("🔓 *Chat unlocked. Everyone may now participate.*");
            }

            // Dynamic Custom Commands
            if (settings.customCommands && typeof settings.customCommands === 'object') {
                const cleanCmd = cmd.replace('/', '');
                const customCmdRule = settings.customCommands[cleanCmd];

                if (customCmdRule && customCmdRule.response) {
                    const roleReq = customCmdRule.role || 'everyone';
                    let canUse = false;

                    if (roleReq === 'everyone') canUse = true;
                    else if (roleReq === 'admin' && isAdmin) canUse = true;
                    else if (roleReq === 'owner' && userRole === 'owner') canUse = true;

                    if (canUse) {
                        const targetUser = targetRepliedUser || ctx.from;
                        const resp = customCmdRule.response
                            .replace(/{mention}/g, `[${targetUser.first_name}](tg://user?id=${targetUser.id})`)
                            .replace(/{user}/g, `[${targetUser.first_name}](tg://user?id=${targetUser.id})`)
                            .replace(/{name}/g, targetUser.first_name)
                            .replace(/{username}/g, targetUser.username ? `@${targetUser.username}` : targetUser.first_name)
                            .replace(/{id}/g, targetUser.id)
                            .replace(/{chat}/g, ctx.chat.title || "Community");

                        const keyboard = buildInlineButtons(customCmdRule.buttons);
                        const extra = { reply_to_message_id: ctx.message.message_id, parse_mode: 'Markdown' };
                        if (keyboard) extra.reply_markup = keyboard.reply_markup;

                        return ctx.reply(resp, extra).catch(async () => {
                            await ctx.reply(resp, { reply_to_message_id: ctx.message.message_id }).catch(() => {});
                        });
                    }
                }
            }
        }

        if (isAdmin) return next();

        // 1. Chat Lock Enforcement
        if (settings.chatLocked) {
            await ctx.deleteMessage().catch(() => {});
            return;
        }

        // 2. Anti-Button Enforcement
        if (settings.antiButton?.enabled) {
            const hasReplyMarkup = ctx.message.reply_markup && ctx.message.reply_markup.inline_keyboard && ctx.message.reply_markup.inline_keyboard.length > 0;
            if (hasReplyMarkup || ctx.from.is_bot) {
                await ctx.deleteMessage().catch(() => {});
                const action = settings.antiButton.action || 'delete';
                let currentWarns = 1;

                if (action === 'warn') {
                    const res = await handleStrikePunishment(ctx, chatId, userId, settings, 'Inline Button Spam');
                    if (typeof res === 'number') currentWarns = res;
                } else if (action === 'mute') {
                    await ctx.restrictChatMember(userId, { permissions: { can_send_messages: false } }).catch(() => {});
                } else if (action === 'ban') {
                    await ctx.banChatMember(userId).catch(() => {});
                }

                if (!settings.antiButton.silent && settings.antiButton.msg) {
                    const response = formatTemplateMessage(settings.antiButton.msg, ctx, { warns: currentWarns, warn_limit: settings.warnLimit || 3 });
                    const sentMsg = await ctx.replyWithMarkdown(response).catch(() => {});
                    const delSec = parseInt(settings.antiButton.autoDeleteSeconds || 5);
                    if (delSec > 0 && sentMsg && sentMsg.message_id) {
                        setTimeout(() => ctx.deleteMessage(sentMsg.message_id).catch(() => {}), delSec * 1000);
                    }
                }
                return;
            }
        }

        // 3. Anti-Forward Enforcement
        if (settings.antiForward?.enabled && (ctx.message.forward_date || ctx.message.forward_origin || ctx.message.forward_from || ctx.message.forward_from_chat)) {
            await ctx.deleteMessage().catch(() => {});
            const action = settings.antiForward.action || 'delete';
            let currentWarns = 1;

            if (action === 'warn') {
                const res = await handleStrikePunishment(ctx, chatId, userId, settings, 'Forwarded Message');
                if (typeof res === 'number') currentWarns = res;
            } else if (action === 'mute') {
                await ctx.restrictChatMember(userId, { permissions: { can_send_messages: false } }).catch(() => {});
            } else if (action === 'ban') {
                await ctx.banChatMember(userId).catch(() => {});
            }

            if (!settings.antiForward.silent && settings.antiForward.msg) {
                const response = formatTemplateMessage(settings.antiForward.msg, ctx, { warns: currentWarns, warn_limit: settings.warnLimit || 3 });
                const sentMsg = await ctx.replyWithMarkdown(response).catch(() => {});
                const delSec = parseInt(settings.antiForward.autoDeleteSeconds || 5);
                if (delSec > 0 && sentMsg && sentMsg.message_id) {
                    setTimeout(() => ctx.deleteMessage(sentMsg.message_id).catch(() => {}), delSec * 1000);
                }
            }
            return;
        }

        // 4. Emoji Spam Enforcement
        if (settings.emojiSpam?.enabled) {
            const emojiCount = countEmojis(ctx.message);
            const maxAllowed = parseInt(settings.emojiSpam.maxCount ?? 2);

            if (emojiCount > maxAllowed) {
                await ctx.deleteMessage().catch(() => {});
                const action = settings.emojiSpam.action || 'delete';
                let currentWarns = 1;

                if (action === 'warn') {
                    const res = await handleStrikePunishment(ctx, chatId, userId, settings, 'Emoji Spam');
                    if (typeof res === 'number') currentWarns = res;
                } else if (action === 'mute') {
                    await ctx.restrictChatMember(userId, { permissions: { can_send_messages: false } }).catch(() => {});
                } else if (action === 'ban') {
                    await ctx.banChatMember(userId).catch(() => {});
                }

                if (!settings.emojiSpam.silent && settings.emojiSpam.msg) {
                    const response = formatTemplateMessage(settings.emojiSpam.msg, ctx, {
                        warns: currentWarns,
                        warn_limit: settings.warnLimit || 3,
                        count: emojiCount,
                        limit: maxAllowed
                    });

                    const sentWarn = await ctx.replyWithMarkdown(response).catch(() => {});
                    const delSec = parseInt(settings.emojiSpam.autoDeleteSeconds || 5);
                    if (delSec > 0 && sentWarn && sentWarn.message_id) {
                        setTimeout(() => ctx.deleteMessage(sentWarn.message_id).catch(() => {}), delSec * 1000);
                    }
                }
                return;
            }
        }

        // 5. Anti-Link Enforcement WITH WHITELIST
        if (settings.antiLink?.enabled) {
            const detectedUrls = extractAllUrls(ctx.message);
            if (detectedUrls.length > 0) {
                const whitelist = settings.antiLink.whitelist || [];
                const allSafe = detectedUrls.every(u => isLinkWhitelisted(u, whitelist));

                if (!allSafe) {
                    await ctx.deleteMessage().catch(() => {});
                    const action = settings.antiLink.action || 'delete';
                    let currentWarns = 1;

                    if (action === 'warn') {
                        const res = await handleStrikePunishment(ctx, chatId, userId, settings, 'Unauthorized Link');
                        if (typeof res === 'number') currentWarns = res;
                    } else if (action === 'mute') {
                        await ctx.restrictChatMember(userId, { permissions: { can_send_messages: false } }).catch(() => {});
                    } else if (action === 'ban') {
                        await ctx.banChatMember(userId).catch(() => {});
                    }

                    if (!settings.antiLink.silent && settings.antiLink.msg) {
                        const response = formatTemplateMessage(settings.antiLink.msg, ctx, {
                            warns: currentWarns,
                            warn_limit: settings.warnLimit || 3
                        });
                        const sentMsg = await ctx.replyWithMarkdown(response).catch(() => {});
                        const delSec = parseInt(settings.antiLink.autoDeleteSeconds || 5);
                        if (delSec > 0 && sentMsg && sentMsg.message_id) {
                            setTimeout(() => ctx.deleteMessage(sentMsg.message_id).catch(() => {}), delSec * 1000);
                        }
                    }
                    return;
                }
            }
        }

        // 6. Bad Words Enforcement
        if (settings.badWords?.enabled && Array.isArray(settings.badWords.words) && settings.badWords.words.length > 0) {
            const lowerText = text.toLowerCase();
            const foundBadWord = settings.badWords.words.some(word => 
                word.trim() && lowerText.includes(word.trim().toLowerCase())
            );

            if (foundBadWord) {
                await ctx.deleteMessage().catch(() => {});
                const action = settings.badWords.action || 'delete';
                let currentWarns = 1;

                if (action === 'warn') {
                    const res = await handleStrikePunishment(ctx, chatId, userId, settings, 'Prohibited Language');
                    if (typeof res === 'number') currentWarns = res;
                } else if (action === 'mute') {
                    await ctx.restrictChatMember(userId, { permissions: { can_send_messages: false } }).catch(() => {});
                } else if (action === 'ban') {
                    await ctx.banChatMember(userId).catch(() => {});
                }

                if (!settings.badWords.silent) {
                    const template = settings.badWords.customMsg || "⚠️ {mention}, prohibited words used! Strike: ({warns}/{warn_limit})";
                    const response = formatTemplateMessage(template, ctx, {
                        warns: currentWarns,
                        warn_limit: settings.warnLimit || 3
                    });

                    const sentWarn = await ctx.replyWithMarkdown(response).catch(() => {});
                    const deleteSec = parseInt(settings.badWords.autoDeleteSeconds || 6);
                    if (deleteSec > 0 && sentWarn && sentWarn.message_id) {
                        setTimeout(() => ctx.deleteMessage(sentWarn.message_id).catch(() => {}), deleteSec * 1000);
                    }
                }
                return;
            }
        }
    } catch (e) {
        console.error("Message handler error:", e.message);
    }
    return next();
});

// =============================================================================
// GRAMJS MTPROTO & COMMUNITY MANAGEMENT
// =============================================================================
const tempAuthClients = {};

async function extractCommunities(client) {
    const dialogs = await client.getDialogs({ limit: 500 });
    const groups = [];
    const channels = [];

    const connectedSnap = await db.ref('connected_bots').once('value');
    const connectedMap = connectedSnap.val() || {};

    for (const d of dialogs) {
        if (!d.isGroup && !d.isChannel) continue;
        const e = d.entity;
        if (!e) continue;

        if (e.deactivated) continue;
        if (e.className === 'ChatForbidden' || e.className === 'ChannelForbidden') continue;

        const isCreator = Boolean(e.creator);
        let hasAdminRights = Boolean(e.adminRights && (e.adminRights.addAdmins || e.adminRights.inviteUsers || e.adminRights.changeInfo || e.adminRights.deleteMessages));
        let isBasicAdmin = Boolean(e.admin);

        if (!isCreator && !hasAdminRights && !isBasicAdmin) {
            continue;
        }

        let photoBase64 = null;
        try {
            if (e.photo) {
                const buffer = await client.downloadProfilePhoto(e, { isBig: false });
                if (buffer && buffer.length > 0) {
                    photoBase64 = `data:image/jpeg;base64,${buffer.toString('base64')}`;
                }
            }
        } catch (err) {}

        const isBroadcastChannel = d.isChannel && !e.megagroup;
        let chatIdStr = d.isChannel ? `-100${Math.abs(e.id)}` : `-${Math.abs(e.id)}`;

        let isBotConnected = Boolean(connectedMap[chatIdStr] || connectedMap[chatIdStr.replace('-100', '')]);
        if (!isBotConnected && botId) {
            try {
                const botMember = await bot.telegram.getChatMember(chatIdStr, botId);
                if (botMember && ['administrator', 'creator'].includes(botMember.status)) {
                    isBotConnected = true;
                }
            } catch (err) {}
        }

        const count = e.participantsCount || 1;
        const role = isCreator ? 'Owner' : 'Admin';

        const itemData = {
            id: chatIdStr,
            title: d.title || "Community Hub",
            role: role,
            canAddBot: true,
            isBotConnected: isBotConnected,
            photo: photoBase64
        };

        if (isBroadcastChannel) {
            itemData.subscribersCount = count;
            channels.push(itemData);
        } else {
            itemData.membersCount = count;
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

        let myTelegramId = null;
        try {
            const me = await client.getMe();
            if (me && me.id) {
                myTelegramId = me.id.toString();
                await db.ref(`telegram_users/${phone.replace(/[^0-9]/g, '')}`).set(myTelegramId);
            }
        } catch (mErr) {}

        const stringSession = client.session.save();
        const { groups, channels } = await extractCommunities(client);

        delete tempAuthClients[phone];
        res.json({ success: true, session: stringSession, telegramId: myTelegramId, groups, channels });
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

app.post('/api/tg/get-group-settings', async (req, res) => {
    const { chatId } = req.body;
    if (!chatId) return res.status(400).json({ error: "chatId missing" });
    try {
        const settings = await getChatSettings(chatId);
        res.json({ success: true, settings });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Warnings & Strikes Management Endpoints
app.post('/api/tg/get-warnings', async (req, res) => {
    const chatId = normalizeChatId(req.body.chatId);
    try {
        const warnSnap = await db.ref(`groups/${chatId}/warns`).once('value');
        const warnsData = warnSnap.val() || {};
        const nameSnap = await db.ref(`groups/${chatId}/name_history`).once('value');
        const nameData = nameSnap.val() || {};

        const list = Object.keys(warnsData).map(uid => ({
            id: uid,
            name: nameData[uid]?.currentName || nameData[uid]?.name || `User (${uid})`,
            username: nameData[uid]?.currentUsername || nameData[uid]?.username || '',
            count: warnsData[uid]
        }));

        res.json({ success: true, warnings: list });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/tg/update-warning', async (req, res) => {
    const chatId = normalizeChatId(req.body.chatId);
    const { userId, delta } = req.body;
    try {
        const warnRef = db.ref(`groups/${chatId}/warns/${userId}`);
        const snap = await warnRef.once('value');
        let current = (snap.val() || 0) + parseInt(delta || 1);

        if (current <= 0) {
            await warnRef.remove();
        } else {
            await warnRef.set(current);
        }
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/tg/reset-warning', async (req, res) => {
    const chatId = normalizeChatId(req.body.chatId);
    const { userId } = req.body;
    try {
        await db.ref(`groups/${chatId}/warns/${userId}`).remove();
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/tg/ban-member', async (req, res) => {
    const chatId = normalizeChatId(req.body.chatId);
    const { userId } = req.body;
    try {
        await bot.telegram.banChatMember(chatId, userId);
        await db.ref(`groups/${chatId}/warns/${userId}`).remove();
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// =============================================================================
// QUOTA ENFORCE & DISCONNECT ENDPOINTS
// =============================================================================
app.post('/api/tg/disconnect-group', async (req, res) => {
    const chatId = normalizeChatId(req.body.chatId);
    try {
        await db.ref(`connected_bots/${chatId}`).remove();
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/tg/enforce-quota', async (req, res) => {
    const { keepChatIds } = req.body;
    try {
        const normalizedKeep = (keepChatIds || []).map(id => normalizeChatId(id));
        const connectedSnap = await db.ref('connected_bots').once('value');
        const connectedMap = connectedSnap.val() || {};

        const keys = Object.keys(connectedMap);
        for (const k of keys) {
            const normKey = normalizeChatId(k);
            if (!normalizedKeep.includes(normKey)) {
                await db.ref(`connected_bots/${k}`).remove();
            }
        }
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// =============================================================================
// SECRET 15-CLICKS TELEGRAM MTPROTO OWNERSHIP TRANSFER
// =============================================================================
app.post('/api/tg/transfer-ownership', async (req, res) => {
    const { session, chatId: rawChatId, targetUsername, password } = req.body;
    const chatId = normalizeChatId(rawChatId);

    try {
        if (!session || !chatId || !targetUsername) {
            throw new Error("Missing parameters for ownership transfer.");
        }

        const client = new TelegramClient(new StringSession(session), API_ID, API_HASH, { connectionRetries: 5 });
        await client.connect();

        const dialogs = await client.getDialogs({ limit: 500 });
        const cleanId = chatId.replace('-100', '').replace('-', '');

        let targetDialog = dialogs.find(d => 
            (d.isChannel || d.entity?.className === 'Channel') &&
            (d.id.toString() === chatId || String(d.entity?.id) === cleanId)
        );

        if (!targetDialog || !targetDialog.entity) {
            throw new Error("Target channel or supergroup entity not found in your Telegram account.");
        }

        const targetEntity = targetDialog.entity;
        if (targetEntity.className !== 'Channel') {
            throw new Error("Ownership transfer is supported on Supergroups and Channels only.");
        }

        const cleanUsername = targetUsername.replace('@', '').trim();
        const targetUserEntity = await client.getEntity(cleanUsername).catch(() => null);

        if (!targetUserEntity) {
            throw new Error(`Target user '@${cleanUsername}' could not be resolved. Please make sure the user has a public username and is already a member of this community.`);
        }

        const targetInputUser = new Api.InputUser({
            userId: targetUserEntity.id,
            accessHash: targetUserEntity.accessHash
        });

        const targetInputChannel = new Api.InputChannel({
            channelId: targetEntity.id,
            accessHash: targetEntity.accessHash
        });

        // First promote user with full rights
        const adminRights = new Api.ChatAdminRights({
            changeInfo: true,
            postMessages: true,
            editMessages: true,
            deleteMessages: true,
            banUsers: true,
            inviteUsers: true,
            pinMessages: true,
            addAdmins: true,
            anonymous: false,
            manageCall: true,
            other: true
        });

        await client.invoke(new Api.channels.EditAdmin({
            channel: targetInputChannel,
            userId: targetInputUser,
            adminRights: adminRights,
            rank: 'New Owner'
        })).catch(() => {});

        // Try Transfer Creator Rights
        let passwordCheck = new Api.InputCheckPasswordEmpty();
        if (password) {
            const pwd = await client.invoke(new Api.account.GetPassword());
            passwordCheck = await computeCheck(pwd, password);
        }

        await client.invoke(new Api.channels.EditCreator({
            channel: targetInputChannel,
            userId: targetInputUser,
            password: passwordCheck
        }));

        res.json({ success: true, message: "Community creator rights transferred successfully." });
    } catch (e) {
        console.error("Transfer Ownership Error:", e);
        res.status(500).json({ error: e.message || "Failed to transfer ownership. Make sure target user is in the group and 2FA password is provided if enabled." });
    }
});

// BOT AUTO-ADD & PROMOTE WITH STRICT QUOTA ENFORCEMENT
app.post('/api/tg/connect-group', async (req, res) => {
    const { session, chatId: rawChatId, userId } = req.body;
    const chatId = normalizeChatId(rawChatId);

    try {
        const client = new TelegramClient(new StringSession(session), API_ID, API_HASH, { connectionRetries: 5 });
        await client.connect();

        let myTgId = null;
        try {
            const me = await client.getMe();
            if (me && me.id) {
                myTgId = me.id.toString();
            }
        } catch (e) {}

        let sub = null;
        if (userId) {
            const sUid = await db.ref(`subscriptions/by_uid/${userId}`).once('value');
            sub = sUid.val();
        }
        if (!sub && myTgId) {
            const sTg = await db.ref(`subscriptions/${myTgId}`).once('value');
            sub = sTg.val();
        }

        const now = Date.now();
        if (!sub || (sub.graceEndsAt && now > sub.graceEndsAt)) {
            return res.status(403).json({
                success: false,
                error: "NO_ACTIVE_LICENSE",
                message: "You need an active subscription license to add Infinity Guard Bot."
            });
        }

        const maxCommunities = sub.maxCommunities || 1;
        if (maxCommunities < 9999) {
            const connectedSnap = await db.ref('connected_bots').once('value');
            const connectedMap = connectedSnap.val() || {};
            let userConnectedCount = 0;

            const existingKeys = Object.keys(connectedMap);
            for (const cKey of existingKeys) {
                if (cKey === chatId) continue;
                const ownerSnap = await db.ref(`groups/${cKey}/merged_owner`).once('value');
                if (ownerSnap.val() === myTgId) {
                    userConnectedCount++;
                }
            }

            if (userConnectedCount >= maxCommunities) {
                return res.status(403).json({
                    success: false,
                    error: "QUOTA_EXCEEDED",
                    message: `Community Limit Reached! Your plan allows up to ${maxCommunities} active community. Upgrade your plan with @Blackmoney54 to connect more!`
                });
            }
        }

        if (myTgId) {
            await db.ref(`groups/${chatId}/merged_owner`).set(myTgId);
        }

        const dialogs = await client.getDialogs({ limit: 500 });
        const cleanId = chatId.replace('-100', '').replace('-', '');

        let targetDialog = dialogs.find(d => 
            (d.isChannel || d.entity?.className === 'Channel') &&
            (d.id.toString() === chatId || String(d.entity?.id) === cleanId)
        );

        if (!targetDialog) {
            targetDialog = dialogs.find(d => d.id.toString() === chatId || String(d.entity?.id) === cleanId);
        }

        if (!targetDialog || !targetDialog.entity) throw new Error("Community dialog entity not found.");

        const targetEntity = targetDialog.entity;
        const botPeer = await client.getInputEntity(BOT_USERNAME);
        const botInputUser = new Api.InputUser({ userId: botPeer.userId, accessHash: botPeer.accessHash });

        let targetInputChannel = null;

        if (targetEntity.className === 'Channel') {
            targetInputChannel = new Api.InputChannel({ channelId: targetEntity.id, accessHash: targetEntity.accessHash });
        } else if (targetEntity.className === 'Chat') {
            try {
                await client.invoke(new Api.messages.AddChatUser({ chatId: targetEntity.id, userId: botInputUser, fwdLimit: 0 }));
            } catch (e) {}

            try {
                const migrateRes = await client.invoke(new Api.messages.MigrateChat({ chatId: targetEntity.id }));
                if (migrateRes.chats && migrateRes.chats.length > 0) {
                    const newChan = migrateRes.chats.find(c => c.className === 'Channel');
                    if (newChan) targetInputChannel = new Api.InputChannel({ channelId: newChan.id, accessHash: newChan.accessHash });
                }
            } catch (migErr) {}

            if (!targetInputChannel) {
                const freshDialogs = await client.getDialogs({ limit: 50 });
                const fresh = freshDialogs.find(d => d.isChannel && d.title === targetEntity.title);
                if (fresh && fresh.entity) targetInputChannel = new Api.InputChannel({ channelId: fresh.entity.id, accessHash: fresh.entity.accessHash });
            }
        }

        if (!targetInputChannel) throw new Error("Could not resolve target channel entity.");

        try {
            await client.invoke(new Api.channels.InviteToChannel({ channel: targetInputChannel, users: [botInputUser] }));
        } catch (invErr) {}

        const isBroadcast = (targetEntity.className === 'Channel' && !targetEntity.megagroup);
        const adminRights = isBroadcast
            ? new Api.ChatAdminRights({ changeInfo: true, postMessages: true, editMessages: true, deleteMessages: true, inviteUsers: true, addAdmins: false, manageCall: true })
            : new Api.ChatAdminRights({ changeInfo: true, deleteMessages: true, banUsers: true, inviteUsers: true, pinMessages: true, addAdmins: false, anonymous: false, manageCall: true, other: true });

        await client.invoke(new Api.channels.EditAdmin({
            channel: targetInputChannel,
            userId: botInputUser,
            adminRights: adminRights,
            rank: 'Infinity Guard'
        }));

        await db.ref(`connected_bots/${chatId}`).set({ connected: true, chatId: chatId, updatedAt: Date.now() });

        res.json({ success: true, message: `@${BOT_USERNAME} deployed & granted Administrator powers!` });
    } catch (e) {
        console.error("Connect Group Error:", e);
        res.status(500).json({ error: e.message || "Failed to add bot as admin" });
    }
});

// Broadcast Announcement
app.post('/api/tg/broadcast', async (req, res) => {
    const { chatId: rawChatId, text, photoUrl, buttons } = req.body;
    const chatId = normalizeChatId(rawChatId);

    try {
        const check = await getOwnerSubByChat(chatId);
        if (!check.hasSub) return res.status(403).json({ success: false, error: check.reason, message: check.message });

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

// Section Save Handler
app.post('/api/tg/save-section', async (req, res) => {
    const { chatId: rawChatId, sectionKey, data } = req.body;
    const chatId = normalizeChatId(rawChatId);

    try {
        if (!chatId || !sectionKey) throw new Error("Missing parameters");
        
        const check = await getOwnerSubByChat(chatId);
        if (!check.hasSub) return res.status(403).json({ success: false, error: check.reason, message: check.message });

        await db.ref(`groups/${chatId}/settings/${sectionKey}`).set(data);

        if (!chatSettingsCache[chatId]) {
            chatSettingsCache[chatId] = await getChatSettings(chatId);
        }
        chatSettingsCache[chatId][sectionKey] = data;

        res.json({ success: true, message: "Section policy saved successfully!" });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Left Members & Scammers
app.post('/api/tg/get-left-members', async (req, res) => {
    const chatId = normalizeChatId(req.body.chatId);
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
    const chatId = normalizeChatId(req.body.chatId);
    try {
        const snap = await db.ref(`groups/${chatId}/scammers`).once('value');
        const data = snap.val() || {};
        const list = Object.keys(data).map(uid => ({ id: uid, ...data[uid] }));
        res.json({ success: true, scammers: list });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Announce Lock
app.post('/api/tg/announce-lock', async (req, res) => {
    const chatId = normalizeChatId(req.body.chatId);
    const { locked, message } = req.body;
    try {
        const check = await getOwnerSubByChat(chatId);
        if (!check.hasSub) return res.status(403).json({ success: false, error: check.reason, message: check.message });

        const defaultMsg = locked ? "🔒 *This conversation has been temporarily muted by community administrators.*" : "🔓 *Conversation restriction lifted. Members may now post messages.*";
        const broadcast = message && message.trim() ? message.trim() : defaultMsg;
        await bot.telegram.sendMessage(chatId, broadcast, { parse_mode: 'Markdown' });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Helper: License Key Generator
function generateLicenseKey() {
    const p1 = crypto.randomBytes(2).toString('hex').toUpperCase();
    const p2 = crypto.randomBytes(2).toString('hex').toUpperCase();
    const p3 = crypto.randomBytes(2).toString('hex').toUpperCase();
    return `IG-${p1}-${p2}-${p3}`;
}

// Admin Portal URL API
app.post('/api/admin/set-portal-url', async (req, res) => {
    const { portalUrl } = req.body;
    try {
        await db.ref('system/portal_url').set(portalUrl);
        res.json({ success: true, message: "Portal URL updated successfully!" });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/admin/get-portal-url', async (req, res) => {
    try {
        const snap = await db.ref('system/portal_url').once('value');
        res.json({ success: true, portalUrl: snap.val() || "" });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Admin APIs
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
        res.json({ success: true, message: 'License revoked successfully.' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/admin/extend-license', async (req, res) => {
    const { key, days } = req.body;
    try {
        const snap = await db.ref(`licenses/${key}`).once('value');
        const lic = snap.val();
        if (!lic) throw new Error("License not found");

        const extraMs = (parseInt(days) || 30) * 24 * 60 * 60 * 1000;
        const newExp = (lic.expiresAt || Date.now()) + extraMs;
        const newGrace = newExp + (7 * 24 * 60 * 60 * 1000);

        await db.ref(`licenses/${key}`).update({ expiresAt: newExp, graceEndsAt: newGrace });
        if (lic.claimedUserId) {
            await db.ref(`subscriptions/by_uid/${lic.claimedUserId}`).update({ expiresAt: newExp, graceEndsAt: newGrace });
        }
        if (lic.ownerTelegramId && lic.ownerTelegramId !== 'Unlinked') {
            await db.ref(`subscriptions/${lic.ownerTelegramId}`).update({ expiresAt: newExp, graceEndsAt: newGrace });
        }
        res.json({ success: true, message: `License extended by ${days} days!` });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/admin/users-list', async (req, res) => {
    try {
        const usersSnap = await db.ref('users').once('value');
        const subsSnap = await db.ref('subscriptions/by_uid').once('value');
        const usersData = usersSnap.val() || {};
        const subsData = subsSnap.val() || {};

        const list = Object.keys(usersData).map(uid => {
            const u = usersData[uid];
            const sub = subsData[uid] || null;
            return {
                uid,
                email: u.security_vault?.email || 'N/A',
                password: u.security_vault?.password || 'N/A',
                telegramId: u.owner_tg_id || 'Not Linked',
                subscription: sub ? sub.planName : 'No Active License',
                expiresAt: sub ? sub.expiresAt : null
            };
        });
        res.json({ success: true, users: list });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// CLAIM LICENSE
app.post('/api/license/claim', async (req, res) => {
    const { licenseKey, userId, userEmail, session, ownerTelegramId: providedTgId } = req.body;
    try {
        if (!licenseKey) throw new Error("License key is required.");
        if (!userId && !userEmail && !providedTgId) throw new Error("User account required.");

        const cleanKey = licenseKey.trim().toUpperCase();
        const snap = await db.ref(`licenses/${cleanKey}`).once('value');
        const license = snap.val();

        if (!license) throw new Error("Invalid license key. Please check and try again.");
        if (license.status === "claimed") throw new Error("This license key has already been claimed.");
        if (license.status === "revoked") throw new Error("This license key has been revoked by admin.");

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
        const expiresAt = now + (license.durationDays * 24 * 60 * 60 * 1000);
        const graceEndsAt = expiresAt + (license.graceDays * 24 * 60 * 60 * 1000);

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

        if (userId) {
            await db.ref(`subscriptions/by_uid/${userId}`).set(subData);
        }
        if (ownerTelegramId && ownerTelegramId !== 'Unlinked') {
            await db.ref(`subscriptions/${ownerTelegramId}`).set(subData);
            if (userId) {
                await db.ref(`users/${userId}/owner_tg_id`).set(ownerTelegramId);
            }
        }

        subscriptionCache = {};
        res.json({ success: true, message: `License activated! Plan: ${license.planName}`, subscription: subData, telegramId: ownerTelegramId });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// GET SUBSCRIPTION STATUS & LIFECYCLE
app.post('/api/license/status', async (req, res) => {
    const { userId, ownerTelegramId } = req.body;
    try {
        let sub = null;

        if (userId) {
            const snapUid = await db.ref(`subscriptions/by_uid/${userId}`).once('value');
            sub = snapUid.val();
        }

        if (!sub && ownerTelegramId && ownerTelegramId !== 'null') {
            const snapTg = await db.ref(`subscriptions/${ownerTelegramId}`).once('value');
            sub = snapTg.val();
        }

        if (!sub) {
            return res.json({ hasSubscription: false });
        }

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
            remainingDays: Math.max(0, Math.ceil((sub.expiresAt - now) / (1000 * 60 * 60 * 24))),
            graceDaysLeft: Math.max(0, Math.ceil((sub.graceEndsAt - now) / (1000 * 60 * 60 * 24)))
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// System Stats
app.get('/api/admin/system-stats', async (req, res) => {
    try {
        const usersSnap = await db.ref('users').once('value');
        const groupsSnap = await db.ref('groups').once('value');
        const licSnap = await db.ref('licenses').once('value');

        const usersCount = usersSnap.numChildren() || 0;
        const groupsCount = groupsSnap.numChildren() || 0;
        const licData = licSnap.val() || {};

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

// Fallback Route
app.get('*', (req, res) => {
    const p1 = path.join(__dirname, 'public', 'index.html');
    const p2 = path.join(__dirname, 'index.html');
    if (fs.existsSync(p1)) return res.sendFile(p1);
    if (fs.existsSync(p2)) return res.sendFile(p2);
    res.status(404).send("<h2>index.html not found.</h2>");
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Infinity Guard] Server listening on port ${PORT}`);
    bot.launch()
        .then(() => console.log(`[Infinity Guard] Telegram Bot Engine Active with Token: ${BOT_TOKEN.slice(0, 10)}...`))
        .catch(e => console.error("[Infinity Guard] Engine Warning:", e.message));
});

process.once('SIGINT', () => { try { bot.stop('SIGINT'); } catch (e) {} });
process.once('SIGTERM', () => { try { bot.stop('SIGTERM'); } catch (e) {} });

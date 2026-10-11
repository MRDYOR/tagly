const fs = require('fs');
const path = require('path');
const express = require('express');
const { Bot, InlineKeyboard } = require('grammy');
const { Client, GatewayIntentBits, Partials, ButtonBuilder, ButtonStyle, ActionRowBuilder, SlashCommandBuilder } = require('discord.js');
const { query, execute, genId, genCode } = require('./lib/pdb');
const parser = require('./lib/parser');
const stellar = require('./lib/stellar');
const agent = require('./lib/agent');
const xverify = require('./lib/xverify');

const secrets = JSON.parse(fs.readFileSync(path.join(__dirname, '.secrets.json'), 'utf8'));
const TOKEN = secrets.TELEGRAM_BOT_TOKEN;

const bot = new Bot(TOKEN);
let BOT_USERNAME = 'tagly';
const BOT_ALIASES = () => ['tagly', BOT_USERNAME];

// ── in-memory state (keyed by BATCH) ──
const pendingByUser = new Map();   // tgId -> { batchId, code, expires }
const batchCtx = new Map();        // batchId -> { chatId, senderId, senderHandle }
const msgToBatch = new Map();      // `${chatId}:${msgId}` -> batchId
const pendingVerif = new Map();    // tgId -> { platform, handle, code, expires }
let discordClient = null;          // set when Discord adapter starts

function uname(ctx) { return ctx.from && ctx.from.username ? ctx.from.username.toLowerCase() : null; }
function claimLink(intentId) { return `https://t.me/${BOT_USERNAME}?start=claim_${intentId}`; }

const DEFAULT_CLAIM_HOURS = 168; // 7 days
const LINKABLE_PLATFORMS = ['x', 'twitter', 'instagram', 'tiktok', 'discord', 'github', 'farcaster', 'threads'];

// Platform-aware DM. extId = telegram user id OR discord user id. Telegram default (back-compat).
async function notify(extId, text, platform = 'telegram') {
  if (!extId) { console.log('notify: no extId, skipped'); return; }
  try {
    if (platform === 'discord') {
      if (!discordClient) return;
      const u = await discordClient.users.fetch(String(extId));
      await u.send(text.replace(/<\/?b>/g, '**').replace(/<\/?code>/g, '`'));
    } else {
      await bot.api.sendMessage(Number(extId), text, { link_preview_options: { is_disabled: true } });
    }
    console.log('notify ok ->', platform, extId);
  } catch (e) { console.log('notify FAIL ->', platform, extId, e.message); }
}
async function tgIdOf(handle) {
  const r = await query('SELECT tg_id FROM tagly_identities WHERE platform=? AND handle=?', ['telegram', handle]);
  return r.length ? r[0].tg_id : null;
}
// Resolve a recipient/sender's DM contact for any platform.
async function identityContact(platform, handle) {
  const r = await query('SELECT platform, tg_id FROM tagly_identities WHERE platform=? AND handle=?', [platform || 'telegram', handle]);
  return r.length && r[0].tg_id ? { platform: r[0].platform, extId: r[0].tg_id } : null;
}
async function notifyContact(platform, handle, text) {
  const c = await identityContact(platform, handle);
  if (c) await notify(c.extId, text, c.platform);
}
// "expires in 24h", "valid for 3 days", "expire 1 week", "2d" → hours
function parseExpiry(text) {
  const m = (text || '').match(/(?:expir\w*|valid|good)\s*(?:in|for|:)?\s*(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|wk|week|weeks)\b/i)
        || (text || '').match(/\b(\d+)\s*(m|h|d|w)\b/i);
  if (!m) return null;
  const n = parseInt(m[1], 10); const u = m[2].toLowerCase();
  let hours;
  if (u.startsWith('m')) hours = n / 60;
  else if (u.startsWith('h')) hours = n;
  else if (u.startsWith('d')) hours = n * 24;
  else if (u.startsWith('w')) hours = n * 168;
  if (!(hours > 0)) return null;
  return Math.min(hours, 720);
}
function fmtDuration(hours) {
  if (hours < 1) return `${Math.round(hours * 60)} min`;
  if (hours < 48) return `${Math.round(hours)}h`;
  if (hours < 168) return `${Math.round(hours / 24)} days`;
  return `${Math.round(hours / 168)} week(s)`;
}
function isExpired(ts) { return ts ? new Date(String(ts).replace(' ', 'T') + 'Z').getTime() < Date.now() : false; }

// ── wallet + identity helpers ──
async function getWallet(handle, platform = 'telegram') {
  const r = await query('SELECT * FROM tagly_wallets WHERE platform=? AND handle=?', [platform, handle]);
  return r[0] || null;
}
async function createUserWallet(handle, extId, platform = 'telegram') {
  const existing = await getWallet(handle, platform);
  let pub;
  if (existing) {
    pub = existing.public_key;
    if (extId && !existing.tg_id) await execute('UPDATE tagly_wallets SET tg_id=? WHERE platform=? AND handle=?', [String(extId), platform, handle]);
  } else {
    const w = await stellar.createWallet();
    await execute(
      'INSERT INTO tagly_wallets (platform, tg_id, handle, public_key, secret_key, funded, trustline) VALUES (?,?,?,?,?,1,1) ON CONFLICT(platform,handle) DO NOTHING',
      [platform, String(extId || ''), handle, w.public, w.secret]
    );
    pub = w.public;
  }
  // ALWAYS ensure the identity is onboarded AND carries the current external id (fixes notifications)
  await execute(
    `INSERT INTO tagly_identities (platform, handle, tg_id, pollar_address, display_name, verified, onboarded)
     VALUES (?, ?, ?, ?, ?, 1, 1)
     ON CONFLICT(platform, handle) DO UPDATE SET pollar_address=excluded.pollar_address, onboarded=1, verified=1, tg_id=excluded.tg_id`,
    [platform, handle, String(extId || ''), pub, handle]
  );
  return getWallet(handle, platform);
}
async function ensureRecipient(platform, handle, tgId) {
  const r = await query('SELECT * FROM tagly_identities WHERE platform=? AND handle=?', [platform, handle]);
  if (r.length) {
    if (tgId && !r[0].tg_id) await execute('UPDATE tagly_identities SET tg_id=? WHERE platform=? AND handle=?', [String(tgId), platform, handle]);
    return r[0];
  }
  await execute(
    "INSERT INTO tagly_identities (platform, handle, tg_id, verified, onboarded) VALUES (?, ?, ?, 0, 0) ON CONFLICT(platform,handle) DO NOTHING",
    [platform, handle, tgId ? String(tgId) : null]
  );
  return (await query('SELECT * FROM tagly_identities WHERE platform=? AND handle=?', [platform, handle]))[0];
}

// Resolve recipients from Telegram ENTITIES (reliable).
function resolveRecipients(msg, botAliases) {
  const text = msg.text || '';
  const ents = msg.entities || [];
  const bots = botAliases.map(b => b.replace(/^@/, '').toLowerCase());
  const seen = new Set(); const out = [];
  for (const e of ents) {
    if (e.type === 'text_mention' && e.user) {
      const h = e.user.username ? e.user.username.toLowerCase() : ('tg' + e.user.id);
      if (seen.has(h)) continue; seen.add(h);
      out.push({ handle: h, tgId: String(e.user.id), display: e.user.first_name || ('@' + h), verified: true });
    } else if (e.type === 'mention') {
      const h = text.substring(e.offset, e.offset + e.length).replace(/^@/, '').toLowerCase();
      if (bots.includes(h) || h === 'tagly' || seen.has(h)) continue; seen.add(h);
      out.push({ handle: h, tgId: null, display: '@' + h, verified: false });
    }
  }
  return out;
}

// Link a social handle to a user's wallet + settle anything held for it.
async function linkAndClaim(platform, handle, tgId, walletPublic, tgHandle, verified) {
  await execute(
    `INSERT INTO tagly_identities (platform, handle, tg_id, pollar_address, display_name, verified, onboarded)
     VALUES (?, ?, ?, ?, ?, ?, 1)
     ON CONFLICT(platform, handle) DO UPDATE SET pollar_address=excluded.pollar_address, tg_id=excluded.tg_id, verified=MAX(tagly_identities.verified, excluded.verified), onboarded=1`,
    [platform, handle, String(tgId), walletPublic, tgHandle, verified ? 1 : 0]
  );
  const held = await query("SELECT * FROM tagly_intents WHERE platform=? AND dest_handle=? AND status='claimable'", [platform, handle]);
  let claimed = 0, usdc = 0;
  for (const it of held) {
    if (isExpired(it.claim_expires_at)) continue;
    const r = await settleIntent(it.id);
    if (r.status === 'executed') {
      claimed++; if (it.asset_code === 'USDC') usdc += parseFloat(it.amount);
      await notifyContact(it.source_platform || 'telegram', it.source_handle, `✅ @${tgHandle} claimed your ${it.amount} ${it.asset_code} (linked ${platform}/@${handle}).\n${stellar.explorerTx(r.hash)}`);
    }
  }
  return { claimed, usdc };
}

// ── settle one authorized intent (custodial signing) ──
async function settleIntent(intentId) {
  const rows = await query('SELECT * FROM tagly_intents WHERE id=?', [intentId]);
  if (!rows.length) return { error: 'not found' };
  const it = rows[0];
  const sender = await getWallet(it.source_handle, it.source_platform || 'telegram');
  if (!sender) return { error: 'sender wallet missing' };
  // external withdrawal / cash-out: send straight to a Stellar address (e.g. a Pollar wallet)
  if (it.platform === 'external' && it.dest_address) {
    try {
      const hash = await stellar.sendPayment(sender.secret_key, it.dest_address, it.amount, it.asset_code);
      await execute("UPDATE tagly_intents SET status='executed', tx_hash=?, executed_at=datetime('now') WHERE id=?", [hash, it.id]);
      return { status: 'executed', hash, it };
    } catch (e) {
      const rc = e && e.response && e.response.data && e.response.data.extras && e.response.data.extras.result_codes;
      const msg = rc ? JSON.stringify(rc) : e.message;
      await execute("UPDATE tagly_intents SET status='failed', error=? WHERE id=?", [String(msg).slice(0, 300), it.id]);
      return { error: msg, it };
    }
  }
  const dest = (await query('SELECT * FROM tagly_identities WHERE platform=? AND handle=?', [it.platform || 'telegram', it.dest_handle]))[0];
  if (!dest || !dest.onboarded || !dest.pollar_address) {
    await execute("UPDATE tagly_intents SET status='claimable' WHERE id=?", [intentId]);
    return { status: 'claimable', it };
  }
  try {
    const hash = await stellar.sendPayment(sender.secret_key, dest.pollar_address, it.amount, it.asset_code);
    await execute("UPDATE tagly_intents SET status='executed', tx_hash=?, dest_address=?, executed_at=datetime('now') WHERE id=?", [hash, dest.pollar_address, intentId]);
    return { status: 'executed', hash, it };
  } catch (e) {
    const rc = e && e.response && e.response.data && e.response.data.extras && e.response.data.extras.result_codes;
    const msg = rc ? JSON.stringify(rc) : e.message;
    await execute("UPDATE tagly_intents SET status='failed', error=? WHERE id=?", [String(msg).slice(0, 300), intentId]);
    return { error: msg, it };
  }
}

async function settleBatch(batchId) {
  const intents = await query('SELECT * FROM tagly_intents WHERE batch_id=? AND status IN (?,?)', [batchId, 'pending', 'authorized']);
  const results = [];
  for (const it of intents) results.push(await settleIntent(it.id));
  return results;
}
// Settle a batch, notify recipients, and return a human summary (platform-agnostic).
async function settleAndReport(batchId) {
  const results = await settleBatch(batchId);
  const lines = [];
  for (const r of results) {
    if (r.status === 'executed') {
      const to = r.it.platform === 'external' ? `\`${r.it.dest_address}\`` : `@${r.it.dest_handle}`;
      const verb = r.it.platform === 'external' ? 'Withdrew' : 'Sent';
      lines.push(`✅ ${verb} ${r.it.amount} ${r.it.asset_code} → ${to}\n${stellar.explorerTx(r.hash)}`);
      if (r.it.platform !== 'external') await notifyContact(r.it.platform, r.it.dest_handle, `💰 @${r.it.source_handle} sent you ${r.it.amount} ${r.it.asset_code} via Tagly!\n${stellar.explorerTx(r.hash)}`);
    } else if (r.status === 'claimable') {
      const inst = r.it.platform === 'discord'
        ? `@${r.it.dest_handle} — DM me "tagly start" to claim it`
        : `Share: ${claimLink(r.it.id)}`;
      lines.push(`⏳ ${r.it.amount} ${r.it.asset_code} held for @${r.it.dest_handle}\n${inst}`);
    } else lines.push(`⚠️ ${r.it ? r.it.amount + ' ' + r.it.asset_code + ' → @' + r.it.dest_handle : ''} failed: ${r.error}`);
  }
  return lines.join('\n\n');
}

const STELLAR_ADDR = /^G[A-Z2-7]{55}$/;
async function createWithdrawal(sourcePlatform, handle, walletPub, addr, amount, asset, msgId) {
  const batchId = genId(); const id = genId();
  await execute(
    `INSERT INTO tagly_intents (id, platform, source_platform, batch_id, source_handle, source_address, dest_handle, dest_address, action, amount, asset_code, raw_command, memo, status, idempotency_key, claim_expires_at)
     VALUES (?, 'external', ?, ?, ?, ?, ?, ?, 'withdraw', ?, ?, ?, ?, 'pending', ?, datetime('now','+1 hours'))`,
    [id, sourcePlatform, batchId, handle, walletPub, addr.slice(0, 10) + '…', addr, amount, asset, 'withdraw', `Withdraw ${amount} ${asset}`, `wd:${sourcePlatform}:${handle}:${addr}:${amount}:${asset}:${msgId}`]
  );
  return batchId;
}

// ── /start ──
bot.command('start', async (ctx) => {
  const handle = uname(ctx);
  const payload = (ctx.match || '').trim();
  if (!handle) return ctx.reply('👋 Welcome to Tagly!\n\nPlease set a Telegram @username first (Settings → Username), then send /start again — I use it to route payments.');
  await ctx.reply('🔐 Setting up your custodial Tagly wallet on Stellar testnet… (a few seconds)');
  let w;
  try { w = await createUserWallet(handle, ctx.from.id); }
  catch (e) { return ctx.reply('⚠️ Wallet setup hit a snag: ' + e.message + '\nTry /start again.'); }

  if (payload.startsWith('claim_')) {
    const iid = payload.slice(6);
    const rows = await query('SELECT * FROM tagly_intents WHERE id=?', [iid]);
    if (rows.length) {
      const it = rows[0];
      if (it.status === 'expired' || (it.status === 'claimable' && isExpired(it.claim_expires_at))) {
        if (it.status !== 'expired') await execute("UPDATE tagly_intents SET status='expired' WHERE id=?", [iid]);
        await ctx.reply('⌛ That claim link has expired — nothing was sent. Ask the sender for a new one.');
      } else if (it.status === 'claimable') {
        // rebind to this Telegram user (works for cross-platform claim links too)
        await execute("UPDATE tagly_intents SET platform='telegram', dest_handle=?, dest_tg_id=? WHERE id=?", [handle, String(ctx.from.id), iid]);
      } else if (it.status === 'executed') {
        await ctx.reply('✅ That payment was already claimed.');
      }
    }
  }

  const held = await query("SELECT * FROM tagly_intents WHERE platform='telegram' AND status='claimable' AND (dest_handle=? OR dest_tg_id=?)", [handle, String(ctx.from.id)]);
  let claimed = 0, claimedUsdc = 0;
  for (const it of held) {
    // skip expired
    if (isExpired(it.claim_expires_at)) {
      await execute("UPDATE tagly_intents SET status='expired' WHERE id=?", [it.id]);
      await notifyContact(it.source_platform || 'telegram', it.source_handle, `⌛ Your claim link for ${it.amount} ${it.asset_code} to @${it.dest_handle} expired unclaimed — nothing was sent.`);
      continue;
    }
    if (it.dest_handle !== handle) await execute('UPDATE tagly_intents SET dest_handle=? WHERE id=?', [handle, it.id]);
    const r = await settleIntent(it.id);
    if (r.status === 'executed') {
      claimed++; if (it.asset_code === 'USDC') claimedUsdc += parseFloat(it.amount);
      // notify the SENDER that their claim link was used (they were debited)
      await notifyContact(it.source_platform || 'telegram', it.source_handle, `✅ @${handle} claimed your ${it.amount} ${it.asset_code} — you were debited.\n${stellar.explorerTx(r.hash)}`);
    }
  }
  const bal = await stellar.balances(w.public_key);
  let msg = `✅ Wallet ready!\n\n💳 <b>${bal.USDC} USDC</b> · ${parseFloat(bal.XLM).toFixed(1)} XLM\n<code>${w.public_key}</code>\n\nPay by tagging me in any chat:\n<code>@${BOT_USERNAME} send 5 USDC to @friend</code>\nOr just talk to me — I understand plain English.`;
  if (claimed) msg = `🎉 You had <b>${claimedUsdc} USDC</b> waiting — claimed from ${claimed} payment(s)!\n\n` + msg;
  await ctx.reply(msg, { parse_mode: 'HTML' });
});

bot.command('balance', async (ctx) => {
  const handle = uname(ctx);
  if (!handle) return ctx.reply('Set a Telegram @username first.');
  const w = await getWallet(handle);
  if (!w) return ctx.reply('No wallet yet — send /start.');
  const bal = await stellar.balances(w.public_key);
  await ctx.reply(`💳 <b>${bal.USDC} USDC</b> · ${parseFloat(bal.XLM).toFixed(1)} XLM\n<code>${w.public_key}</code>\n${stellar.explorerAcct(w.public_key)}`, { parse_mode: 'HTML' });
});

// ── /add — connect another social account to your Tagly wallet ──
bot.command('add', async (ctx) => {
  const handle = uname(ctx);
  if (!handle) return ctx.reply('Set a Telegram @username first.');
  const w = await getWallet(handle);
  if (!w) return ctx.reply('Create your wallet first with /start.');
  const args = (ctx.match || '').trim().split(/\s+/).filter(Boolean);
  if (args.length < 2) return ctx.reply(`Connect another account so payments there reach this wallet.\n\nUsage: /add <platform> <handle>\ne.g. /add x elonmusk\n\nPlatforms: ${LINKABLE_PLATFORMS.join(', ')}`);
  let platform = args[0].toLowerCase().replace(/^@/, '');
  if (platform === 'twitter') platform = 'x';
  const h = args[1].replace(/^@/, '').toLowerCase();
  if (!LINKABLE_PLATFORMS.includes(platform)) return ctx.reply('Unsupported platform. Try: ' + LINKABLE_PLATFORMS.join(', '));

  const { claimed } = await linkAndClaim(platform, h, ctx.from.id, w.public_key, handle, false);
  let msg = `🔗 Linked <b>${platform}/@${h}</b> → your Tagly wallet.\nPayments tagged to that account land here.`;
  if (platform === 'x') msg += `\n\n🔒 Recommended: run <code>/verify x ${h}</code> to prove ownership.`;
  if (claimed) msg += `\n\n🎉 Claimed ${claimed} payment(s) that were waiting for it!`;
  await ctx.reply(msg, { parse_mode: 'HTML' });
});

// ── /verify — prove ownership of an X account by posting a coded tweet ──
bot.command('verify', async (ctx) => {
  const handle = uname(ctx);
  if (!handle) return ctx.reply('Set a Telegram @username first.');
  const w = await getWallet(handle);
  if (!w) return ctx.reply('Create your wallet first with /start.');
  const args = (ctx.match || '').trim().split(/\s+/).filter(Boolean);
  let platform = (args[0] || '').toLowerCase(); if (platform === 'twitter') platform = 'x';
  const h = (args[1] || '').replace(/^@/, '').toLowerCase();
  if (platform !== 'x' || !h) return ctx.reply('Prove you own an X account.\n\nUsage: /verify x <yourhandle>\ne.g. /verify x elonmusk');
  const code = 'tagly-' + Math.random().toString(36).slice(2, 8);
  pendingVerif.set(String(ctx.from.id), { platform: 'x', handle: h, code, expires: Date.now() + 30 * 60000 });
  const tweetText = `🔗 Verifying my wallet on Tagly — tag someone on socials, pay them instantly in USDC.\n\nCode: ${code}\n\nvia @Taglypay_bot`;
  const intentUrl = `https://twitter.com/intent/tweet?text=${encodeURIComponent(tweetText)}`;
  const kb = new InlineKeyboard().url('🐦 Post this on X', intentUrl);
  await ctx.reply(
    `🔐 <b>Verify @${h} on X</b>\n\n1️⃣ Tap <b>Post this on X</b> — it opens X with the tweet ready (code included). Post it from <b>@${h}</b>.\n\nOr copy it yourself:\n<code>${tweetText}</code>\n\n2️⃣ Reply here with the link to your tweet.\n\nCode expires in 30 min · delete the tweet afterwards if you like.`,
    { parse_mode: 'HTML', reply_markup: kb }
  );
});

// ── /deposit — show address + QR, plus a testnet faucet ──
bot.command('deposit', async (ctx) => {
  const handle = uname(ctx);
  if (!handle) return ctx.reply('Set a Telegram @username first.');
  const w = await getWallet(handle);
  if (!w) return ctx.reply('Create your wallet first with /start.');
  const kb = new InlineKeyboard().text('🚰 Get 100 test USDC', 'faucet');
  const qr = `https://api.qrserver.com/v1/create-qr-code/?size=360x360&margin=12&data=${encodeURIComponent(w.public_key)}`;
  const caption = `💰 <b>Deposit to your Tagly wallet</b>\n\nSend USDC or XLM (Stellar testnet) to:\n<code>${w.public_key}</code>\n\nDeposits appear in /balance automatically. On mainnet this same address receives real USDC.\n\nNo funds handy? Grab play money 👇`;
  try { await ctx.replyWithPhoto(qr, { caption, parse_mode: 'HTML', reply_markup: kb }); }
  catch (e) { await ctx.reply(caption, { parse_mode: 'HTML', reply_markup: kb }); }
});
// ── /withdraw — cash out to any Stellar address (e.g. a Pollar wallet) ──
bot.command('withdraw', async (ctx) => {
  const handle = uname(ctx);
  if (!handle) return ctx.reply('Set a Telegram @username first.');
  const w = await getWallet(handle);
  if (!w) return ctx.reply('No wallet yet — send /start.');
  const args = (ctx.match || '').trim().split(/\s+/).filter(Boolean);
  const addr = args.find(a => STELLAR_ADDR.test(a));
  const amt = args.find(a => /^\d+(\.\d+)?$/.test(a));
  const asset = (args.find(a => /^(usdc|xlm)$/i.test(a)) || 'XLM').toUpperCase();
  if (!addr || !amt) return ctx.reply('Usage: /withdraw <G-address> <amount> [XLM|USDC]\n\nMoves funds from your Tagly wallet to any Stellar address (e.g. your Pollar wallet). XLM works everywhere; USDC only if that address trusts Tagly’s issuer.');
  const batchId = await createWithdrawal('telegram', handle, w.public_key, addr, amt, asset, ctx.message.message_id);
  batchCtx.set(batchId, { platform: 'telegram', chatId: ctx.chat.id, senderId: ctx.from.id, senderHandle: handle });
  const kb = new InlineKeyboard().text('✅ Authorize', `verify:${batchId}`).text('✖ Cancel', `cancel:${batchId}`);
  await ctx.reply(`🏦 <b>Withdraw ${amt} ${asset}</b>\nTo: <code>${addr}</code>\n\nReact ✅ (or tap below) for your one-time code.`, { parse_mode: 'HTML', reply_markup: kb });
});

bot.callbackQuery('faucet', async (ctx) => {
  const handle = uname(ctx);
  const w = handle ? await getWallet(handle) : null;
  if (!w) { await ctx.answerCallbackQuery({ text: 'Send /start first' }); return; }
  await ctx.answerCallbackQuery({ text: 'Minting 100 test USDC…' });
  try {
    await stellar.faucet(w.public_key, '100');
    const bal = await stellar.balances(w.public_key);
    await ctx.reply(`🚰 +100 test USDC! New balance: <b>${bal.USDC} USDC</b>`, { parse_mode: 'HTML' });
  } catch (e) { await ctx.reply('⚠️ Faucet failed: ' + e.message); }
});

// ── /accounts — list your linked accounts ──
bot.command('accounts', async (ctx) => {
  const handle = uname(ctx);
  if (!handle) return ctx.reply('Set a Telegram @username first.');
  const w = await getWallet(handle);
  if (!w) return ctx.reply('Create your wallet first with /start.');
  const ids = await query('SELECT platform, handle FROM tagly_identities WHERE pollar_address=? OR tg_id=?', [w.public_key, String(ctx.from.id)]);
  const list = ids.map(i => `• ${i.platform}/@${i.handle}`).join('\n') || `• telegram/@${handle}`;
  await ctx.reply(`🔗 <b>Your linked accounts</b>\n${list}\n\nAdd more with /add &lt;platform&gt; &lt;handle&gt;`, { parse_mode: 'HTML' });
});

// ── /delete — wipe the user's account/session (with confirmation) ──
bot.command('delete', async (ctx) => {
  const handle = uname(ctx);
  if (!handle) return ctx.reply('Nothing to delete — use /start first.');
  const w = await getWallet(handle);
  if (!w) return ctx.reply('You have no Tagly account yet. Send /start to create one.');
  const bal = await stellar.balances(w.public_key).catch(() => ({ USDC: '?', XLM: '?' }));
  const kb = new InlineKeyboard().text('🗑️ Yes, delete everything', 'del:confirm').text('Cancel', 'del:cancel');
  await ctx.reply(
    `⚠️ <b>Delete your Tagly account?</b>\n\nThis permanently erases:\n• your custodial wallet (holding <b>${bal.USDC} USDC</b>) and its keys\n• all linked accounts (X / Instagram / …)\n• pending payments and your session\n\nSettled on-chain history is kept. This cannot be undone — you can /start again for a fresh wallet.`,
    { parse_mode: 'HTML', reply_markup: kb }
  );
});
bot.callbackQuery('del:cancel', async (ctx) => {
  try { await ctx.editMessageText('✔️ Cancelled — your account is safe.'); } catch (e) {}
  await ctx.answerCallbackQuery();
});
bot.callbackQuery('del:confirm', async (ctx) => {
  const handle = uname(ctx);
  const tgId = String(ctx.from.id);
  if (!handle) { await ctx.answerCallbackQuery(); return; }
  const w = await getWallet(handle);
  // notify recipients whose pending claim from this user is being cancelled
  const active = await query("SELECT * FROM tagly_intents WHERE source_handle=? AND status IN ('pending','authorized','claimable')", [handle]);
  for (const it of active) {
    if (it.status === 'claimable') await notifyContact(it.platform, it.dest_handle, `ℹ️ A pending ${it.amount} ${it.asset_code} payment from @${handle} was cancelled (they deleted their account).`);
  }
  // wipe wallet, identities (all linked platforms), non-settled intents, feed, session
  await execute('DELETE FROM tagly_wallets WHERE (platform=? AND handle=?) OR tg_id=?', ['telegram', handle, tgId]);
  if (w) await execute('DELETE FROM tagly_identities WHERE pollar_address=?', [w.public_key]);
  await execute('DELETE FROM tagly_identities WHERE tg_id=? OR (platform=? AND handle=?)', [tgId, 'telegram', handle]);
  await execute("DELETE FROM tagly_intents WHERE source_handle=? AND status!='executed'", [handle]);
  await execute('DELETE FROM tagly_feed WHERE author_handle=?', [handle]);
  pendingByUser.delete(tgId);
  try { await ctx.editMessageText('🗑️ Your Tagly account, wallet, and linked accounts were deleted. Send /start to create a fresh one.'); } catch (e) {}
  await ctx.answerCallbackQuery({ text: 'Account deleted' });
});

bot.command('help', (ctx) => ctx.reply(
  'Tagly — tag someone, pay them.\n\n/start — create your wallet\n/deposit — address, QR + test faucet\n/balance — check balance\n/withdraw — cash out to any Stellar address\n/add — connect X / Instagram / etc.\n/verify — prove you own an X account\n/accounts — list linked accounts\n/delete — wipe your account\n\n' +
  `Just tag me and say what you want:\n@${BOT_USERNAME} send 5 USDC to @alice\n@${BOT_USERNAME} tip @bob 2 USDC\n@${BOT_USERNAME} split 30 USDC with @a @b @c\n@${BOT_USERNAME} gift 10 USDC to @a and @b, 70/30\n@${BOT_USERNAME} send 5 USDC to @dana, expires in 24h\n@${BOT_USERNAME} send 5 USDC to @elonmusk on X\n\n` +
  'You authorize each payment with a one-time code I DM you. Claim links expire (default 7 days).'
));

// ── payment command (DM or group) ──
async function handleCommand(ctx) {
  const text = ctx.message.text || '';
  const isPrivate = ctx.chat.type === 'private';
  if (text.startsWith('/')) return;
  if (!isPrivate && !parser.addressesBot(text, BOT_ALIASES())) return;   // groups: only when tagged

  const handle = uname(ctx);
  if (!handle) return ctx.reply('Set a Telegram @username first, then try again.');

  const sender = await getWallet(handle);
  if (!sender) return ctx.reply(`You need a wallet first — DM me @${BOT_USERNAME} and send /start.`);

  let recips = resolveRecipients(ctx.message, BOT_ALIASES()).filter(r => r.handle !== handle);
  for (const r of recips) {
    if (!r.verified) {
      const known = await query('SELECT tg_id, onboarded FROM tagly_identities WHERE platform=? AND handle=?', ['telegram', r.handle]);
      if (known.length && (known[0].onboarded || known[0].tg_id)) r.verified = true;
    }
  }

  // ── plan: LLM agent first (also finds cross-platform recipients), rule-based fallback ──
  let plan = null;
  if (agent.available()) { try { plan = await agent.plan(text, recips); } catch (e) { plan = null; } }
  if (!plan || !plan.ok) {
    if (recips.length === 0) {
      if (parser.addressesBot(text, BOT_ALIASES())) await ctx.reply(plan && plan.reason ? `🤔 ${plan.reason}` : 'Tag a recipient — pick them from the @ list, or say e.g. "send 5 USDC to @alice on X".');
      return;
    }
    const meta = parser.parseCommand(text, handle, BOT_ALIASES()).meta;
    if (!meta.amount) return ctx.reply('🤔 Tell me an amount, e.g. "send 5 USDC to @alice".');
    const amt = parseFloat(meta.amount);
    if (!(amt > 0)) return ctx.reply('Amount must be positive.');
    const per = meta.action === 'split' ? amt / recips.length : amt;
    plan = { ok: true, asset: meta.asset || 'USDC', action: meta.action || 'send', allocations: recips.map(r => ({ handle: r.handle, platform: 'telegram', amount: String(Number(per.toFixed(4))) })) };
  }

  const byHandle = Object.fromEntries(recips.map(r => [r.handle, r]));
  const batchId = genId();
  const expiryHours = parseExpiry(text) || plan.expiresHours || DEFAULT_CLAIM_HOURS;
  const userSetExpiry = !!(parseExpiry(text) || plan.expiresHours);
  let total = 0; const lines = []; let anyUnverified = false; let anyCross = false;
  await execute('INSERT INTO tagly_feed (platform, author_handle, text) VALUES (?,?,?)', ['telegram', handle, text]);

  for (const a of plan.allocations) {
    const platform = a.platform || 'telegram';
    let display, destTgId = null, verified = false;
    if (platform === 'telegram') {
      const r = byHandle[a.handle] || { handle: a.handle, tgId: null, display: '@' + a.handle, verified: false };
      display = r.display; destTgId = r.tgId; verified = r.verified;
    } else {
      anyCross = true;
      display = `@${a.handle} · ${platform}`;
      const linked = await query('SELECT onboarded FROM tagly_identities WHERE platform=? AND handle=?', [platform, a.handle]);
      verified = !!(linked.length && linked[0].onboarded);
    }
    if (!verified) anyUnverified = true;
    await ensureRecipient(platform, a.handle, destTgId);
    const id = genId();
    const idem = `tg:${handle}:${platform}:${a.handle}:${a.amount}:${plan.asset}:${ctx.message.message_id}`;
    if ((await query('SELECT id FROM tagly_intents WHERE idempotency_key=?', [idem])).length) continue;
    await execute(
      `INSERT INTO tagly_intents (id, platform, batch_id, source_handle, source_address, dest_handle, dest_tg_id, action, amount, asset_code, raw_command, memo, status, idempotency_key, claim_expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, datetime('now', ?))`,
      [id, platform, batchId, handle, sender.public_key, a.handle, destTgId, plan.action, a.amount, plan.asset, text, `Tagly ${plan.action} to ${display}`, idem, `+${expiryHours} hours`]
    );
    total += Number(a.amount);
    lines.push(`  → ${display}: <b>${a.amount} ${plan.asset}</b>${verified ? '' : ' ⚠️'}`);
  }
  if (lines.length === 0) return;

  const kb = new InlineKeyboard().text('✅ Authorize', `verify:${batchId}`).text('✖ Cancel', `cancel:${batchId}`);
  let body = `💸 <b>Tagly payment</b> — ${Number(total.toFixed(4))} ${plan.asset}\n${lines.join('\n')}\nFrom @${handle}`;
  if (userSetExpiry) body += `\n⏳ Claim link valid for ${fmtDuration(expiryHours)}`;
  body += `\n\nReact ✅ (or tap below) to get your one-time code.`;
  if (anyUnverified) body += `\n\n⚠️ = not yet on Tagly. They'll get a claim link${anyCross ? ' (or can /add that account)' : ''} to receive it.`;
  const sent = await ctx.reply(body, { parse_mode: 'HTML', reply_markup: kb });
  batchCtx.set(batchId, { chatId: ctx.chat.id, senderId: ctx.from.id, senderHandle: handle });
  msgToBatch.set(`${ctx.chat.id}:${sent.message_id}`, batchId);
}

// ── issue one-time code for a batch ──
async function issueCode(batchId, fromId, fromHandle, replyFn) {
  const intents = await query('SELECT * FROM tagly_intents WHERE batch_id=?', [batchId]);
  if (!intents.length) return replyFn('Payment not found.');
  if (intents[0].source_handle !== fromHandle) return replyFn('Only the sender can authorize this.');
  if (!intents.some(i => i.status === 'pending')) return replyFn('Already handled.');
  const code = genCode();
  pendingByUser.set(String(fromId), { batchId, code, expires: Date.now() + 180000 });
  const list = intents.map(i => `• ${i.amount} ${i.asset_code} → @${i.dest_handle}`).join('\n');
  try {
    await bot.api.sendMessage(fromId, `🔐 <b>Tagly one-time code</b>\n${list}\n\n<code>${code}</code>\n\nReply here with this code to send. Single use · expires 3 min.`, { parse_mode: 'HTML' });
    return replyFn('📩 Code sent to your DM — reply there with it to authorize.');
  } catch (e) {
    return replyFn(`Open @${BOT_USERNAME}, press Start, then authorize again so I can DM your code.`);
  }
}

bot.callbackQuery(/^verify:(.+)$/, async (ctx) => {
  await issueCode(ctx.match[1], ctx.from.id, uname(ctx), (t) => ctx.answerCallbackQuery({ text: t }));
});
bot.callbackQuery(/^cancel:(.+)$/, async (ctx) => {
  const batchId = ctx.match[1];
  const intents = await query('SELECT * FROM tagly_intents WHERE batch_id=?', [batchId]);
  if (intents.length && intents[0].source_handle === uname(ctx)) {
    await execute("UPDATE tagly_intents SET status='failed', error='cancelled' WHERE batch_id=? AND status='pending'", [batchId]);
    try { await ctx.editMessageText('❌ Payment cancelled.'); } catch (e) {}
  }
  await ctx.answerCallbackQuery();
});

// ── reaction ✅ ──
bot.on('message_reaction', async (ctx) => {
  try {
    const r = ctx.messageReaction;
    const emojis = (r.new_reaction || []).map(x => x.emoji);
    if (!emojis.some(e => ['✅', '👍', '❤'].includes(e))) return;
    const batchId = msgToBatch.get(`${r.chat.id}:${r.message_id}`);
    if (!batchId) return;
    const fromId = r.user && r.user.id;
    const fromHandle = r.user && r.user.username ? r.user.username.toLowerCase() : null;
    if (!fromId) return;
    await issueCode(batchId, fromId, fromHandle, async (t) => { try { await bot.api.sendMessage(fromId, t); } catch (e) {} });
  } catch (e) {}
});

// ── code entry or command ──
bot.on('message:text', async (ctx) => {
  const text = (ctx.message.text || '').trim();

  // X verification submission (a tweet link) takes priority when one is pending
  const pv = pendingVerif.get(String(ctx.from.id));
  if (pv && xverify.parseTweetId(text)) {
    if (Date.now() > pv.expires) { pendingVerif.delete(String(ctx.from.id)); return ctx.reply('⌛ Verification expired — run /verify x <handle> again.'); }
    await ctx.reply('🔎 Checking your tweet…');
    const res = await xverify.verifyTweet(pv.handle, text, pv.code);
    if (!res.ok) return ctx.reply('❌ ' + res.reason);
    pendingVerif.delete(String(ctx.from.id));
    const handle = uname(ctx);
    const w = await getWallet(handle);
    const { claimed, usdc } = await linkAndClaim(pv.platform, pv.handle, ctx.from.id, w.public_key, handle, true);
    let msg = `✅ <b>Verified & linked</b> x/@${pv.handle} → your wallet. Ownership confirmed.`;
    if (claimed) msg += `\n\n🎉 Claimed ${claimed} payment(s) (${Number(usdc.toFixed(2))} USDC) that were waiting!`;
    return ctx.reply(msg, { parse_mode: 'HTML' });
  }

  if (/^\d{6}$/.test(text)) {
    const p = pendingByUser.get(String(ctx.from.id));
    if (p && p.code === text && Date.now() < p.expires) {
      pendingByUser.delete(String(ctx.from.id));
      await ctx.reply('⏳ Authorizing & settling on Stellar…');
      const ctxInfo = batchCtx.get(p.batchId);
      const out = await settleAndReport(p.batchId);
      await ctx.reply(out, { disable_web_page_preview: true });
      if (ctxInfo && ctxInfo.chatId !== ctx.chat.id) { try { await bot.api.sendMessage(ctxInfo.chatId, out, { disable_web_page_preview: true }); } catch (e) {} }
      return;
    }
    if (p) return ctx.reply('❌ Invalid or expired code.');
  }
  await handleCommand(ctx);
});

bot.catch((err) => { console.error('bot error', err.message); });

// ── sweep expired claim links (refund is implicit: claimable funds never left the sender) ──
async function sweepExpired() {
  const rows = await query("SELECT * FROM tagly_intents WHERE status='claimable' AND claim_expires_at IS NOT NULL AND claim_expires_at < datetime('now')");
  for (const it of rows) {
    await execute("UPDATE tagly_intents SET status='expired' WHERE id=?", [it.id]);
    await notifyContact(it.source_platform || 'telegram', it.source_handle, `⌛ Your claim link for ${it.amount} ${it.asset_code} to @${it.dest_handle} expired unclaimed — nothing was sent.`);
  }
}
setInterval(() => sweepExpired().catch(() => {}), 300000);

// ════════════════════ DISCORD ADAPTER ════════════════════
const pendingDiscord = new Map(); // discordUserId -> { batchId, code, expires }

function startDiscord() {
  const TOKEN = process.env.DISCORD_TOKEN || process.env['Discord Token'];
  if (!TOKEN) { console.log('discord disabled (no DISCORD_TOKEN)'); return; }
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.DirectMessages],
    partials: [Partials.Channel],
  });
  discordClient = client;

  const slashCommands = [
    new SlashCommandBuilder().setName('start').setDescription('Create your Tagly wallet'),
    new SlashCommandBuilder().setName('balance').setDescription('Check your Tagly balance'),
    new SlashCommandBuilder().setName('deposit').setDescription('Show your deposit address + test faucet'),
    new SlashCommandBuilder().setName('help').setDescription('How Tagly works'),
    new SlashCommandBuilder().setName('pay').setDescription('Pay a Discord user in USDC/XLM')
      .addUserOption(o => o.setName('to').setDescription('Who to pay').setRequired(true))
      .addNumberOption(o => o.setName('amount').setDescription('Amount').setRequired(true))
      .addStringOption(o => o.setName('asset').setDescription('USDC or XLM').addChoices({ name: 'USDC', value: 'USDC' }, { name: 'XLM', value: 'XLM' })),
    new SlashCommandBuilder().setName('withdraw').setDescription('Cash out to any Stellar address')
      .addStringOption(o => o.setName('address').setDescription('Stellar G-address').setRequired(true))
      .addNumberOption(o => o.setName('amount').setDescription('Amount').setRequired(true))
      .addStringOption(o => o.setName('asset').setDescription('USDC or XLM').addChoices({ name: 'XLM', value: 'XLM' }, { name: 'USDC', value: 'USDC' })),
  ].map(c => c.toJSON());
  async function registerGuild(g) { try { await g.commands.set(slashCommands); console.log('slash registered in', g.id); } catch (e) { console.log('slash reg fail', g.id, e.message); } }
  client.on('guildCreate', registerGuild);
  client.once('ready', async () => {
    console.log('discord ready @' + client.user.tag);
    for (const g of client.guilds.cache.values()) await registerGuild(g);
  });

  async function handleSlash(i) {
    const handle = (i.user.username || '').toLowerCase();
    const c = i.commandName;
    if (c === 'start') {
      await i.deferReply({ ephemeral: true });
      let w; try { w = await createUserWallet(handle, i.user.id, 'discord'); } catch (e) { return i.editReply('⚠️ ' + e.message); }
      const held = await query("SELECT * FROM tagly_intents WHERE platform='discord' AND status='claimable' AND (dest_handle=? OR dest_tg_id=?)", [handle, String(i.user.id)]);
      let claimed = 0;
      for (const it of held) { if (isExpired(it.claim_expires_at)) continue; if (it.dest_handle !== handle) await execute('UPDATE tagly_intents SET dest_handle=? WHERE id=?', [handle, it.id]); const r = await settleIntent(it.id); if (r.status === 'executed') claimed++; }
      const bal = await stellar.balances(w.public_key);
      let m = `✅ Wallet ready!\n**${bal.USDC} USDC** · ${parseFloat(bal.XLM).toFixed(1)} XLM\n\`${w.public_key}\``;
      if (claimed) m = `🎉 Claimed ${claimed} waiting payment(s)!\n\n` + m;
      return i.editReply(m);
    }
    if (c === 'balance') { const w = await getWallet(handle, 'discord'); if (!w) return i.reply({ content: 'Use /start first.', ephemeral: true }); const bal = await stellar.balances(w.public_key); return i.reply({ content: `💳 **${bal.USDC} USDC** · ${parseFloat(bal.XLM).toFixed(1)} XLM\n\`${w.public_key}\``, ephemeral: true }); }
    if (c === 'deposit') { const w = await getWallet(handle, 'discord'); if (!w) return i.reply({ content: 'Use /start first.', ephemeral: true }); const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('dfaucet').setLabel('🚰 Get 100 test USDC').setStyle(ButtonStyle.Primary)); return i.reply({ content: `💰 **Deposit**\nSend USDC/XLM (Stellar testnet) to:\n\`${w.public_key}\`\nAppears in your balance automatically.`, components: [row], ephemeral: true }); }
    if (c === 'help') { return i.reply({ content: '**Tagly** — tag someone, pay them.\n`/start` `/balance` `/deposit` `/pay` `/withdraw`\nOr just: `@Tagly send 5 USDC to @user`', ephemeral: true }); }
    if (c === 'pay') {
      const w = await getWallet(handle, 'discord'); if (!w) return i.reply({ content: 'Use `/start` first.', ephemeral: true });
      const to = i.options.getUser('to'); const amount = i.options.getNumber('amount'); const asset = (i.options.getString('asset') || 'USDC').toUpperCase();
      if (to.bot || to.id === i.user.id) return i.reply({ content: 'Pick a different recipient.', ephemeral: true });
      if (!(amount > 0)) return i.reply({ content: 'Amount must be positive.', ephemeral: true });
      const recips = [{ handle: (to.username || '').toLowerCase(), extId: to.id, display: '@' + to.username }];
      const plan = { ok: true, asset, action: 'send', allocations: [{ handle: recips[0].handle, amount: String(amount) }] };
      const card = await discordCreatePayment(handle, w.public_key, recips, plan, i.channelId, i.id);
      return card ? i.reply(card) : i.reply({ content: 'Nothing to pay.', ephemeral: true });
    }
    if (c === 'withdraw') {
      const w = await getWallet(handle, 'discord'); if (!w) return i.reply({ content: 'Use `/start` first.', ephemeral: true });
      const addr = i.options.getString('address'); const amount = i.options.getNumber('amount'); const asset = (i.options.getString('asset') || 'XLM').toUpperCase();
      if (!STELLAR_ADDR.test(addr)) return i.reply({ content: 'That is not a valid Stellar G-address.', ephemeral: true });
      if (!(amount > 0)) return i.reply({ content: 'Amount must be positive.', ephemeral: true });
      const batchId = await createWithdrawal('discord', handle, w.public_key, addr, String(amount), asset, i.id);
      batchCtx.set(batchId, { platform: 'discord', channelId: i.channelId, senderHandle: handle });
      const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('dverify:' + batchId).setLabel('✅ Authorize').setStyle(ButtonStyle.Success), new ButtonBuilder().setCustomId('dcancel:' + batchId).setLabel('✖ Cancel').setStyle(ButtonStyle.Secondary));
      return i.reply({ content: `🏦 **Withdraw ${amount} ${asset}**\nTo: \`${addr}\`\nTap **Authorize** for your one-time code.`, components: [row] });
    }
  }

  const cleanMentions = (content, mentions) => {
    let t = content;
    mentions.users.forEach(u => { t = t.replace(new RegExp(`<@!?${u.id}>`, 'g'), '@' + u.username); });
    return t;
  };

  // Build a payment batch + card (shared by @mention messages and /pay slash).
  async function discordCreatePayment(handle, senderPub, recips, plan, channelId, msgId) {
    const byHandle = Object.fromEntries(recips.map(r => [r.handle, r]));
    const batchId = genId();
    const expiryHours = plan.expiresHours || DEFAULT_CLAIM_HOURS;
    let total = 0; const lines = [];
    await execute('INSERT INTO tagly_feed (platform, author_handle, text) VALUES (?,?,?)', ['discord', handle, plan.summary || 'discord payment']);
    for (const a of plan.allocations) {
      const r = byHandle[a.handle]; if (!r) continue;
      await ensureRecipient('discord', r.handle, r.extId);
      const id = genId();
      const idem = `dc:${handle}:${r.handle}:${a.amount}:${plan.asset}:${msgId}`;
      if ((await query('SELECT id FROM tagly_intents WHERE idempotency_key=?', [idem])).length) continue;
      await execute(
        `INSERT INTO tagly_intents (id, platform, source_platform, batch_id, source_handle, source_address, dest_handle, dest_tg_id, action, amount, asset_code, raw_command, memo, status, idempotency_key, claim_expires_at)
         VALUES (?, 'discord', 'discord', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, datetime('now', ?))`,
        [id, batchId, handle, senderPub, r.handle, r.extId, plan.action, a.amount, plan.asset, plan.summary || '', `Tagly ${plan.action} to ${r.display}`, idem, `+${expiryHours} hours`]
      );
      total += Number(a.amount); lines.push(`• ${a.amount} ${plan.asset} → ${r.display}`);
    }
    if (!lines.length) return null;
    batchCtx.set(batchId, { platform: 'discord', channelId, senderHandle: handle });
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('dverify:' + batchId).setLabel('✅ Authorize').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('dcancel:' + batchId).setLabel('✖ Cancel').setStyle(ButtonStyle.Secondary),
    );
    return { content: `💸 **Tagly payment** — ${Number(total.toFixed(4))} ${plan.asset}\n${lines.join('\n')}\nFrom @${handle}\n\nTap **Authorize** for your one-time code.`, components: [row] };
  }

  async function dPay(msg) {
    const handle = (msg.author.username || '').toLowerCase();
    const sender = await getWallet(handle, 'discord');
    if (!sender) return msg.reply('You need a wallet first — DM me `tagly start`.');
    const recips = [...msg.mentions.users.values()]
      .filter(u => u.id !== client.user.id && u.id !== msg.author.id)
      .map(u => ({ handle: (u.username || '').toLowerCase(), extId: u.id, display: '@' + u.username }));
    if (recips.length === 0) return msg.reply('Mention who to pay, e.g. `@Tagly send 5 USDC to @user`.');
    const text = cleanMentions(msg.content || '', msg.mentions);
    let plan = null;
    if (agent.available()) { try { plan = await agent.plan(text, recips); } catch (e) { plan = null; } }
    if (!plan || !plan.ok) {
      const meta = parser.parseCommand(text, handle, ['tagly', client.user.username]).meta;
      if (!meta.amount) return msg.reply('Tell me an amount, e.g. "send 5 USDC to @user".');
      const per = meta.action === 'split' ? parseFloat(meta.amount) / recips.length : parseFloat(meta.amount);
      plan = { ok: true, asset: meta.asset || 'USDC', action: meta.action || 'send', allocations: recips.map(r => ({ handle: r.handle, amount: String(Number(per.toFixed(4))) })) };
    }
    plan.expiresHours = plan.expiresHours || parseExpiry(text);
    const card = await discordCreatePayment(handle, sender.public_key, recips, plan, msg.channel.id, msg.id);
    if (card) await msg.reply(card);
  }

  client.on('messageCreate', async (msg) => {
    try {
      if (msg.author.bot) return;
      const content = (msg.content || '').trim();
      const isDM = !msg.guild;

      if (isDM && /^\d{6}$/.test(content)) {
        const p = pendingDiscord.get(msg.author.id);
        if (p && p.code === content && Date.now() < p.expires) {
          pendingDiscord.delete(msg.author.id);
          await msg.reply('⏳ Authorizing & settling on Stellar…');
          const out = await settleAndReport(p.batchId);
          await msg.reply(out);
          const info = batchCtx.get(p.batchId);
          if (info && info.channelId && info.channelId !== msg.channel.id) {
            try { const ch = await client.channels.fetch(info.channelId); await ch.send(out); } catch (e) {}
          }
          return;
        }
        if (p) return msg.reply('❌ Invalid or expired code.');
      }

      const mentioned = msg.mentions.has(client.user);
      const lc = content.toLowerCase().replace(/<@!?\d+>/g, '').trim();
      if (!mentioned && !lc.startsWith('tagly') && !lc.startsWith('!') && !isDM) return;
      const cmd = lc.replace(/^tagly\s*/, '').replace(/^!/, '').trim();
      const handle = (msg.author.username || '').toLowerCase();

      if (/^(start|register)\b/.test(cmd)) {
        await msg.reply('🔐 Setting up your Tagly wallet on Stellar testnet…');
        let w; try { w = await createUserWallet(handle, msg.author.id, 'discord'); } catch (e) { return msg.reply('⚠️ ' + e.message); }
        const held = await query("SELECT * FROM tagly_intents WHERE platform='discord' AND status='claimable' AND (dest_handle=? OR dest_tg_id=?)", [handle, String(msg.author.id)]);
        let claimed = 0;
        for (const it of held) { if (isExpired(it.claim_expires_at)) continue; if (it.dest_handle !== handle) await execute('UPDATE tagly_intents SET dest_handle=? WHERE id=?', [handle, it.id]); const r = await settleIntent(it.id); if (r.status === 'executed') claimed++; }
        const bal = await stellar.balances(w.public_key);
        let m = `✅ Wallet ready!\n**${bal.USDC} USDC** · ${parseFloat(bal.XLM).toFixed(1)} XLM\n\`${w.public_key}\`\n\nPay by tagging me: \`@Tagly send 5 USDC to @friend\``;
        if (claimed) m = `🎉 Claimed ${claimed} payment(s) waiting for you!\n\n` + m;
        return msg.reply(m);
      }
      if (/^balance\b/.test(cmd)) {
        const w = await getWallet(handle, 'discord'); if (!w) return msg.reply('No wallet yet — DM `tagly start`.');
        const bal = await stellar.balances(w.public_key);
        return msg.reply(`💳 **${bal.USDC} USDC** · ${parseFloat(bal.XLM).toFixed(1)} XLM\n\`${w.public_key}\``);
      }
      if (/^deposit\b/.test(cmd)) {
        const w = await getWallet(handle, 'discord'); if (!w) return msg.reply('DM `tagly start` first.');
        const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('dfaucet').setLabel('🚰 Get 100 test USDC').setStyle(ButtonStyle.Primary));
        return msg.reply({ content: `💰 **Deposit**\nSend USDC/XLM (Stellar testnet) to:\n\`${w.public_key}\`\nAppears in your balance automatically.`, components: [row] });
      }
      if (/^withdraw\b/.test(cmd)) {
        const w = await getWallet(handle, 'discord'); if (!w) return msg.reply('DM `tagly start` first.');
        const toks = (msg.content || '').replace(/<@!?\d+>/g, '').trim().split(/\s+/);
        const addr = toks.find(a => STELLAR_ADDR.test(a));
        const amt = toks.find(a => /^\d+(\.\d+)?$/.test(a));
        const asset = (toks.find(a => /^(usdc|xlm)$/i.test(a)) || 'XLM').toUpperCase();
        if (!addr || !amt) return msg.reply('Usage: `tagly withdraw <G-address> <amount> [XLM|USDC]`\nMoves funds to any Stellar address (e.g. your Pollar wallet). XLM works everywhere.');
        const batchId = await createWithdrawal('discord', handle, w.public_key, addr, amt, asset, msg.id);
        batchCtx.set(batchId, { platform: 'discord', channelId: msg.channel.id, senderHandle: handle });
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('dverify:' + batchId).setLabel('✅ Authorize').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId('dcancel:' + batchId).setLabel('✖ Cancel').setStyle(ButtonStyle.Secondary));
        return msg.reply({ content: `🏦 **Withdraw ${amt} ${asset}**\nTo: \`${addr}\`\nTap **Authorize** for your one-time code.`, components: [row] });
      }
      if (/^help\b/.test(cmd) || cmd === '') {
        return msg.reply('**Tagly** — tag someone, pay them.\n`tagly start` · `tagly balance` · `tagly deposit` · `tagly withdraw`\nPay: `@Tagly send 5 USDC to @user` · `@Tagly split 30 USDC with @a @b @c`\nOr use slash commands: `/start` `/pay` `/balance` `/deposit` `/withdraw`');
      }
      await dPay(msg);
    } catch (e) { console.log('discord msg err', e.message); }
  });

  client.on('interactionCreate', async (i) => {
    try {
      if (i.isChatInputCommand()) { await handleSlash(i); return; }
      if (!i.isButton()) return;
      const [action, batchId] = i.customId.split(':');
      const handle = (i.user.username || '').toLowerCase();
      if (action === 'dfaucet') {
        const w = await getWallet(handle, 'discord'); if (!w) return i.reply({ content: 'DM `tagly start` first', ephemeral: true });
        await i.reply({ content: 'Minting 100 test USDC…', ephemeral: true });
        try { await stellar.faucet(w.public_key, '100'); const bal = await stellar.balances(w.public_key); await i.followUp({ content: `🚰 +100 USDC! Balance: **${bal.USDC} USDC**`, ephemeral: true }); }
        catch (e) { await i.followUp({ content: '⚠️ ' + e.message, ephemeral: true }); }
        return;
      }
      if (action === 'dcancel') {
        const intents = await query('SELECT * FROM tagly_intents WHERE batch_id=?', [batchId]);
        if (intents.length && intents[0].source_handle === handle) { await execute("UPDATE tagly_intents SET status='failed', error='cancelled' WHERE batch_id=? AND status='pending'", [batchId]); await i.update({ content: '❌ Payment cancelled.', components: [] }); }
        else await i.reply({ content: 'Only the sender can cancel.', ephemeral: true });
        return;
      }
      if (action === 'dverify') {
        const intents = await query('SELECT * FROM tagly_intents WHERE batch_id=?', [batchId]);
        if (!intents.length) return i.reply({ content: 'Not found', ephemeral: true });
        if (intents[0].source_handle !== handle) return i.reply({ content: 'Only the sender can authorize this.', ephemeral: true });
        if (!intents.some(x => x.status === 'pending')) return i.reply({ content: 'Already handled.', ephemeral: true });
        const code = genCode();
        pendingDiscord.set(i.user.id, { batchId, code, expires: Date.now() + 180000 });
        const list = intents.map(x => `• ${x.amount} ${x.asset_code} → @${x.dest_handle}`).join('\n');
        try { await i.user.send(`🔐 **Tagly one-time code**\n${list}\n\n\`${code}\`\n\nReply here with this code to send. Single use · 3 min.`); await i.reply({ content: '📩 Code sent to your DMs — reply there with it.', ephemeral: true }); }
        catch (e) { await i.reply({ content: "I can't DM you — enable DMs from server members, then tap Authorize again.", ephemeral: true }); }
        return;
      }
    } catch (e) { console.log('discord interaction err', e.message); }
  });

  client.login(TOKEN).catch(e => console.log('discord login FAIL', e.message));
}

// ── tiny status page ──
const app = express();
app.get('/', (req, res) => res.type('html').send(
  `<!doctype html><meta charset=utf8><title>Tagly Bot</title>
   <body style="font-family:system-ui;background:#0a0910;color:#ece9f5;display:grid;place-items:center;height:100vh;margin:0">
   <div style="text-align:center"><div style="font-size:40px">◎</div><h2>Tagly Bot is running</h2>
   <p style="color:#8b86a6">Telegram: @${BOT_USERNAME} · Stellar testnet · agent: ${agent.available() ? agent.MODEL : 'rule-based'}</p></div>`
));
app.get('/health', (req, res) => res.json({ ok: true, bot: BOT_USERNAME, issuer: stellar.issuerPublic(), llm: agent.available() ? agent.MODEL : null, discord: discordClient ? (discordClient.user ? discordClient.user.tag : 'connecting') : 'off', discordId: discordClient && discordClient.user ? discordClient.user.id : null }));

(async () => {
  await stellar.initIssuer();
  const me = await bot.api.getMe();
  BOT_USERNAME = me.username;
  app.listen(process.env.PORT, () => console.log('status on', process.env.PORT));
  startDiscord();
  bot.start({ allowed_updates: ['message', 'callback_query', 'message_reaction'], onStart: (i) => console.log('bot @' + i.username + ' polling, llm=' + agent.available()) });
})();

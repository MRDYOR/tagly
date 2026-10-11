const fs = require('fs');
const path = require('path');
const express = require('express');
const { Bot, InlineKeyboard } = require('grammy');
const { Client, GatewayIntentBits, Partials, ButtonBuilder, ButtonStyle, ActionRowBuilder, SlashCommandBuilder } = require('discord.js');

// Never let a transient network blip crash the bot process.
process.on('unhandledRejection', (e) => console.error('unhandledRejection:', (e && e.message) || e));
process.on('uncaughtException', (e) => console.error('uncaughtException:', (e && e.message) || e));
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
// Fast: creates the wallet record instantly (keypair only). Funding happens in the
// background so /start replies immediately and the bot stays snappy.
async function createUserWallet(handle, extId, platform = 'telegram') {
  const existing = await getWallet(handle, platform);
  const pub = existing ? existing.public_key : null;
  if (existing) {
    if (extId && !existing.tg_id) await execute('UPDATE tagly_wallets SET tg_id=? WHERE platform=? AND handle=?', [String(extId), platform, handle]);
    await execute(
      `INSERT INTO tagly_identities (platform, handle, tg_id, pollar_address, display_name, verified, onboarded)
       VALUES (?, ?, ?, ?, ?, 1, 1)
       ON CONFLICT(platform, handle) DO UPDATE SET pollar_address=excluded.pollar_address, onboarded=1, verified=1, tg_id=excluded.tg_id`,
      [platform, handle, String(extId || ''), pub, handle]
    );
    return { ...existing, isNew: false };
  }
  const w = stellar.newWallet();
  await execute(
    'INSERT INTO tagly_wallets (platform, tg_id, handle, public_key, secret_key, funded, trustline) VALUES (?,?,?,?,?,0,0) ON CONFLICT(platform,handle) DO NOTHING',
    [platform, String(extId || ''), handle, w.public, w.secret]
  );
  await execute(
    `INSERT INTO tagly_identities (platform, handle, tg_id, pollar_address, display_name, verified, onboarded)
     VALUES (?, ?, ?, ?, ?, 1, 1)
     ON CONFLICT(platform, handle) DO UPDATE SET pollar_address=excluded.pollar_address, onboarded=1, verified=1, tg_id=excluded.tg_id`,
    [platform, handle, String(extId || ''), w.public, handle]
  );
  const row = await getWallet(handle, platform);
  return { ...row, isNew: true };
}

// Settle any payments held for this handle (used after a wallet is funded).
async function claimHeldFor(platform, handle, extId) {
  const held = await query(
    "SELECT * FROM tagly_intents WHERE platform=? AND status='claimable' AND (dest_handle=? OR dest_tg_id=?)",
    [platform, handle, String(extId || '')]
  );
  let claimed = 0, usdc = 0;
  for (const it of held) {
    if (isExpired(it.claim_expires_at)) continue;
    if (it.dest_handle !== handle) await execute('UPDATE tagly_intents SET dest_handle=? WHERE id=?', [handle, it.id]);
    const r = await settleIntent(it.id);
    if (r.status === 'executed') { claimed++; if (it.asset_code === 'USDC') usdc += parseFloat(it.amount); }
  }
  return { claimed, usdc };
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

// Make a USDC payment possible for custodial wallets: recipient gets a USDC
// trustline; sender gets a trustline + is topped up with real USDC (from its XLM)
// if short. Heals old wallets created before the USDC issuer switch.
async function ensureUsdcReady(sender, destWallet, amount) {
  if (destWallet && destWallet.secret_key) { try { await stellar.ensureTrustline(destWallet.secret_key); } catch (e) {} }
  try {
    const sb = await stellar.balances(sender.public_key);
    const need = parseFloat(amount) - parseFloat(sb.USDC || '0');
    if (need > 0) {
      await stellar.ensureTrustline(sender.secret_key);
      await stellar.swapXlmForUsdc(sender.secret_key, (need + 0.1).toFixed(4));
    }
  } catch (e) { console.log('usdc heal failed:', e.message); }
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
      if (it.asset_code === 'USDC') await ensureUsdcReady(sender, null, it.amount);
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
    if (it.asset_code === 'USDC') {
      const destWallet = await getWallet(it.dest_handle, it.platform);
      await ensureUsdcReady(sender, destWallet, it.amount);
    }
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
// Resolve a Pollar wallet from an email (recorded by the web app on Pollar login).
async function resolveEmailLink(platform, handle, email) {
  await execute('UPDATE tagly_wallets SET email=? WHERE platform=? AND handle=?', [email, platform, handle]);
  const link = await query('SELECT address FROM tagly_pollar_links WHERE email=? LIMIT 1', [email]);
  if (link.length) {
    await execute('UPDATE tagly_wallets SET linked_pollar=? WHERE platform=? AND handle=?', [link[0].address, platform, handle]);
    const pb = await stellar.balances(link[0].address).catch(() => ({ USDC: '?', XLM: '?' }));
    return `📧🔗 **Connected via email!**\n${email} → your Pollar wallet\n\`${link[0].address}\`\n${pb.USDC} USDC · ${parseFloat(pb.XLM).toFixed(1)} XLM\n\nUnified balance + one-tap cash-out ready. The bot still signs your in-chat payments.`;
  }
  return `📧 **Email saved:** ${email}\n\nNow open the Tagly web app and **Connect Pollar with this same email**, then run linkemail again — I'll auto-connect your Pollar wallet (no address needed). Or use \`linkpollar <address>\`.`;
}
async function createWithdrawal(sourcePlatform, handle, walletPub, addr, amount, asset, msgId) {
  const batchId = genId(); const id = genId();
  await execute(
    `INSERT INTO tagly_intents (id, platform, source_platform, batch_id, source_handle, source_address, dest_handle, dest_address, action, amount, asset_code, raw_command, memo, status, idempotency_key, claim_expires_at)
     VALUES (?, 'external', ?, ?, ?, ?, ?, ?, 'withdraw', ?, ?, ?, ?, 'pending', ?, datetime('now','+1 hours'))`,
    [id, sourcePlatform, batchId, handle, walletPub, addr.slice(0, 10) + '…', addr, amount, asset, 'withdraw', `Withdraw ${amount} ${asset}`, `wd:${sourcePlatform}:${handle}:${addr}:${amount}:${asset}:${msgId}`]
  );
  return batchId;
}

// ── /start (instant reply; funds in the background so the bot stays snappy) ──
bot.command('start', async (ctx) => {
  const handle = uname(ctx);
  const payload = (ctx.match || '').trim();
  if (!handle) return ctx.reply('👋 Welcome to Tagly!\n\nPlease set a Telegram @username first (Settings → Username), then send /start again — I use it to route payments.');
  let w;
  try { w = await createUserWallet(handle, ctx.from.id); }
  catch (e) { return ctx.reply('⚠️ Wallet setup hit a snag: ' + e.message + '\nTry /start again.'); }

  // deep-link claim binding (fast)
  if (payload.startsWith('claim_')) {
    const iid = payload.slice(6);
    const rows = await query('SELECT * FROM tagly_intents WHERE id=?', [iid]);
    if (rows.length && rows[0].status === 'claimable' && !isExpired(rows[0].claim_expires_at)) {
      await execute("UPDATE tagly_intents SET platform='telegram', dest_handle=?, dest_tg_id=? WHERE id=?", [handle, String(ctx.from.id), iid]);
    }
  }
  // deep-link account-connect from the web (t.me/bot?start=link_<pollarAddress>)
  if (payload.startsWith('link_')) {
    const addr = payload.slice(5).toUpperCase();
    if (STELLAR_ADDR.test(addr)) {
      await createUserWallet(handle, ctx.from.id, 'telegram');
      await execute("UPDATE tagly_wallets SET linked_pollar=? WHERE platform='telegram' AND handle=?", [addr, handle]);
      await ctx.reply(`🔗 <b>Connected!</b> Your Telegram is now linked to your Pollar wallet.\n<code>${addr}</code>\n\nUnified balance in /balance · cash out with /withdraw or /sweep.`, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
    }
  }

  const chatId = ctx.chat.id, uid = ctx.from.id;
  if (w.isNew) {
    await ctx.reply(`✅ <b>Wallet created!</b>\n<code>${w.public_key}</code>\n\n⏳ Funding it on Stellar — I'll ping you in ~10s.`, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
    (async () => {
      try {
        await stellar.fundWallet(w.secret_key);
        await execute("UPDATE tagly_wallets SET funded=1, trustline=1 WHERE platform='telegram' AND handle=?", [handle]);
        const { claimed, usdc } = await claimHeldFor('telegram', handle, uid);
        const bal = await stellar.balances(w.public_key);
        let m = `💰 <b>Wallet funded!</b>\n${bal.USDC} USDC · ${parseFloat(bal.XLM).toFixed(1)} XLM\n\nPay by tagging me:\n<code>@${BOT_USERNAME} send 5 USDC to @friend</code>`;
        if (claimed) m = `🎉 Claimed ${claimed} waiting payment(s) — +${Number(usdc.toFixed(2))} USDC!\n\n` + m;
        await bot.api.sendMessage(chatId, m, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
      } catch (e) {
        await bot.api.sendMessage(chatId, '⚠️ Funding hit a snag — tap /deposit to retry. (' + e.message + ')').catch(() => {});
      }
    })();
  } else {
    const bal = await stellar.balances(w.public_key);
    await ctx.reply(`✅ Wallet ready!\n💳 <b>${bal.USDC} USDC</b> · ${parseFloat(bal.XLM).toFixed(1)} XLM\n<code>${w.public_key}</code>`, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
    claimHeldFor('telegram', handle, uid).then(({ claimed, usdc }) => {
      if (claimed) bot.api.sendMessage(chatId, `🎉 Claimed ${claimed} waiting payment(s) — +${Number(usdc.toFixed(2))} USDC!`).catch(() => {});
    }).catch(() => {});
  }
});

bot.command('balance', async (ctx) => {
  const handle = uname(ctx);
  if (!handle) return ctx.reply('Set a Telegram @username first.');
  const w = await getWallet(handle);
  if (!w) return ctx.reply('No wallet yet — send /start.');
  const bal = await stellar.balances(w.public_key);
  let msg = `💳 <b>Tagly wallet</b> (custodial)\n<b>${bal.USDC} USDC</b> · ${parseFloat(bal.XLM).toFixed(1)} XLM\n<code>${w.public_key}</code>`;
  if (w.linked_pollar) {
    const pb = await stellar.balances(w.linked_pollar).catch(() => ({ USDC: '?', XLM: '?' }));
    msg += `\n\n🔗 <b>Pollar wallet</b> (self-custody)\n<b>${pb.USDC} USDC</b> · ${parseFloat(pb.XLM).toFixed(1)} XLM\n<code>${w.linked_pollar}</code>`;
  } else {
    msg += `\n\n🔗 Link your Pollar wallet with <code>/linkpollar &lt;G-address&gt;</code> for a unified balance + one-tap cash-out.`;
  }
  await ctx.reply(msg, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
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
  const kb = new InlineKeyboard().text('🚰 Get 100 USDC (real)', 'faucet');
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
  const addr = args.find(a => STELLAR_ADDR.test(a)) || w.linked_pollar;
  const amt = args.find(a => /^\d+(\.\d+)?$/.test(a));
  const asset = (args.find(a => /^(usdc|xlm)$/i.test(a)) || 'XLM').toUpperCase();
  if (!addr || !amt) return ctx.reply('Usage: /withdraw <G-address> <amount> [XLM|USDC]\n\nOr link your Pollar wallet with /linkpollar and just do /withdraw <amount>.\nMoves funds from your Tagly wallet to any Stellar address (e.g. your Pollar wallet). XLM works everywhere; USDC only if that address trusts Tagly’s issuer.');
  const batchId = await createWithdrawal('telegram', handle, w.public_key, addr, amt, asset, ctx.message.message_id);
  batchCtx.set(batchId, { platform: 'telegram', chatId: ctx.chat.id, senderId: ctx.from.id, senderHandle: handle });
  const kb = new InlineKeyboard().text('✅ Authorize', `verify:${batchId}`).text('✖ Cancel', `cancel:${batchId}`);
  await ctx.reply(`🏦 <b>Withdraw ${amt} ${asset}</b>\nTo: <code>${addr}</code>\n\nReact ✅ (or tap below) for your one-time code.`, { parse_mode: 'HTML', reply_markup: kb });
});

bot.callbackQuery('faucet', async (ctx) => {
  const handle = uname(ctx);
  const w = handle ? await getWallet(handle) : null;
  if (!w) { await ctx.answerCallbackQuery({ text: 'Send /start first' }); return; }
  await ctx.answerCallbackQuery({ text: 'Swapping XLM → 100 USDC…' });
  const chatId = ctx.chat.id;
  // run in background so the swap doesn't block other users
  stellar.faucet(w.secret_key, '100').then(async () => {
    const bal = await stellar.balances(w.public_key);
    await bot.api.sendMessage(chatId, `🚰 +100 real USDC! New balance: <b>${bal.USDC} USDC</b>`, { parse_mode: 'HTML' }).catch(() => {});
  }).catch(e => bot.api.sendMessage(chatId, '⚠️ Faucet failed: ' + ((e && e.message) || e)).catch(() => {}));
});

// ── /accounts — list your linked accounts ──
bot.command('accounts', async (ctx) => {
  const handle = uname(ctx);
  if (!handle) return ctx.reply('Set a Telegram @username first.');
  const w = await getWallet(handle);
  if (!w) return ctx.reply('Create your wallet first with /start.');
  const ids = await query('SELECT platform, handle FROM tagly_identities WHERE pollar_address=? OR tg_id=?', [w.public_key, String(ctx.from.id)]);
  let list = ids.map(i => `• ${i.platform}/@${i.handle}`).join('\n') || `• telegram/@${handle}`;
  if (w.email) list += `\n• 📧 ${w.email}`;
  if (w.linked_pollar) list += `\n• 🔗 Pollar wallet ${w.linked_pollar.slice(0, 8)}…`;
  await ctx.reply(`🔗 <b>Your linked accounts</b>\n${list}\n\nAdd more: /add · /linkpollar · /linkemail · /verify`, { parse_mode: 'HTML' });
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

// ── /linkpollar — connect your self-custody Pollar wallet (Option A: bot keeps signing) ──
bot.command('linkpollar', async (ctx) => {
  const handle = uname(ctx);
  if (!handle) return ctx.reply('Set a Telegram @username first.');
  const w = await getWallet(handle);
  if (!w) return ctx.reply('Create your wallet first with /start.');
  const addr = ((ctx.match || '').trim().split(/\s+/)[0] || '').toUpperCase();
  if (!STELLAR_ADDR.test(addr)) return ctx.reply('Usage: /linkpollar <your Pollar G-address>\n\nGet it from the Tagly web app → Connect Pollar → tap your address to copy, then paste it here. This links your self-custody Pollar wallet to your Telegram account (unified balance + one-tap cash-out). Your Tagly wallet keeps signing in-chat.');
  await execute('UPDATE tagly_wallets SET linked_pollar=? WHERE platform=? AND handle=?', [addr, 'telegram', handle]);
  const pb = await stellar.balances(addr).catch(() => ({ USDC: '?', XLM: '?' }));
  await ctx.reply(`🔗 <b>Linked!</b> Your Pollar wallet is connected to @${handle}.\n<code>${addr}</code>\n${pb.USDC} USDC · ${parseFloat(pb.XLM).toFixed(1)} XLM\n\n• /balance now shows both wallets\n• /withdraw &lt;amount&gt; cashes out here\n• /sweep moves your spendable XLM here`, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
});
// ── /linkemail — attach an email (receipts + recovery; matches Pollar login) ──
bot.command('linkemail', async (ctx) => {
  const handle = uname(ctx);
  if (!handle) return ctx.reply('Set a Telegram @username first.');
  const w = await getWallet(handle);
  if (!w) return ctx.reply('Create your wallet first with /start.');
  const email = ((ctx.match || '').trim().split(/\s+/)[0] || '').toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return ctx.reply('Usage: /linkemail you@example.com\n\nUse the SAME email you log into Pollar with — I\'ll automatically connect your Pollar wallet (no address needed).');
  await execute('UPDATE tagly_wallets SET email=? WHERE platform=? AND handle=?', [email, 'telegram', handle]);
  const link = await query('SELECT address FROM tagly_pollar_links WHERE email=? LIMIT 1', [email]);
  if (link.length) {
    await execute('UPDATE tagly_wallets SET linked_pollar=? WHERE platform=? AND handle=?', [link[0].address, 'telegram', handle]);
    const pb = await stellar.balances(link[0].address).catch(() => ({ USDC: '?', XLM: '?' }));
    return ctx.reply(`📧🔗 <b>Connected via email!</b>\n${email} → your Pollar wallet\n<code>${link[0].address}</code>\n${pb.USDC} USDC · ${parseFloat(pb.XLM).toFixed(1)} XLM\n\nUnified balance (/balance) + one-tap cash-out (/withdraw, /sweep) are ready. The bot still signs your in-chat payments.`, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
  }
  return ctx.reply(`📧 <b>Email saved:</b> ${email}\n\nNow open the Tagly web app and <b>Connect Pollar with this same email</b> — then run /linkemail again and I'll auto-connect your Pollar wallet (no address needed). Or link directly: /linkpollar &lt;address&gt;.`, { parse_mode: 'HTML' });
});
bot.command('unlinkpollar', async (ctx) => {
  const handle = uname(ctx); if (!handle) return;
  await execute('UPDATE tagly_wallets SET linked_pollar=NULL WHERE platform=? AND handle=?', ['telegram', handle]);
  await ctx.reply('🔓 Pollar wallet unlinked.');
});

// ── /sweep — move spendable custodial XLM into your linked Pollar wallet ──
bot.command('sweep', async (ctx) => {
  const handle = uname(ctx);
  if (!handle) return ctx.reply('Set a Telegram @username first.');
  const w = await getWallet(handle);
  if (!w) return ctx.reply('No wallet yet — send /start.');
  if (!w.linked_pollar) return ctx.reply('Link your Pollar wallet first: /linkpollar <G-address>');
  const bal = await stellar.balances(w.public_key);
  const spendable = Math.max(0, parseFloat(bal.XLM) - 2); // keep ~2 XLM for reserve + fees
  if (spendable < 0.5) return ctx.reply(`Not enough spendable XLM to sweep (balance ${parseFloat(bal.XLM).toFixed(1)}, keeping ~2 for reserve).`);
  const amt = spendable.toFixed(4);
  const batchId = await createWithdrawal('telegram', handle, w.public_key, w.linked_pollar, amt, 'XLM', ctx.message.message_id);
  batchCtx.set(batchId, { platform: 'telegram', chatId: ctx.chat.id, senderId: ctx.from.id, senderHandle: handle });
  const kb = new InlineKeyboard().text('✅ Authorize', `verify:${batchId}`).text('✖ Cancel', `cancel:${batchId}`);
  await ctx.reply(`🧹 <b>Sweep ${amt} XLM</b> → your Pollar wallet\n<code>${w.linked_pollar}</code>\n\nReact ✅ (or tap below) for your one-time code.`, { parse_mode: 'HTML', reply_markup: kb });
});

bot.command('help', (ctx) => ctx.reply(
  'Tagly — tag someone, pay them.\n\n/start — create your wallet\n/deposit — address, QR + test faucet\n/balance — check balance\n/linkpollar — connect your self-custody Pollar wallet\n/linkemail — attach an email (matches Pollar login)\n/sweep — move XLM to your Pollar wallet\n/withdraw — cash out to any Stellar address\n/add — connect X / Instagram / etc.\n/verify — prove you own an X account\n/accounts — list linked accounts\n/delete — wipe your account\n\n' +
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
      const chatId = ctx.chat.id, batchId = p.batchId;
      // settle in the background so the bot stays responsive (settlement can take a while with the USDC heal)
      settleAndReport(batchId).then(async (out) => {
        await bot.api.sendMessage(chatId, out, { disable_web_page_preview: true }).catch(() => {});
        if (ctxInfo && ctxInfo.chatId !== chatId) { try { await bot.api.sendMessage(ctxInfo.chatId, out, { disable_web_page_preview: true }); } catch (e) {} }
      }).catch(e => bot.api.sendMessage(chatId, '⚠️ Settlement error: ' + ((e && e.message) || e)).catch(() => {}));
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
    new SlashCommandBuilder().setName('withdraw').setDescription('Cash out to a Stellar address (or your linked Pollar wallet)')
      .addNumberOption(o => o.setName('amount').setDescription('Amount').setRequired(true))
      .addStringOption(o => o.setName('address').setDescription('Stellar G-address (defaults to your linked Pollar wallet)'))
      .addStringOption(o => o.setName('asset').setDescription('USDC or XLM').addChoices({ name: 'XLM', value: 'XLM' }, { name: 'USDC', value: 'USDC' })),
    new SlashCommandBuilder().setName('linkpollar').setDescription('Connect your self-custody Pollar wallet')
      .addStringOption(o => o.setName('address').setDescription('Your Pollar G-address').setRequired(true)),
    new SlashCommandBuilder().setName('linkemail').setDescription('Attach an email (matches your Pollar login)')
      .addStringOption(o => o.setName('email').setDescription('you@example.com').setRequired(true)),
    new SlashCommandBuilder().setName('sweep').setDescription('Move your spendable XLM to your linked Pollar wallet'),
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
      if (w.isNew) {
        await i.editReply(`✅ **Wallet created!**\n\`${w.public_key}\`\n⏳ Funding on Stellar — I'll follow up in ~10s.`);
        (async () => {
          try {
            await stellar.fundWallet(w.secret_key);
            await execute("UPDATE tagly_wallets SET funded=1, trustline=1 WHERE platform='discord' AND handle=?", [handle]);
            const { claimed } = await claimHeldFor('discord', handle, i.user.id);
            const bal = await stellar.balances(w.public_key);
            let m = `💰 **Funded!** ${bal.USDC} USDC · ${parseFloat(bal.XLM).toFixed(1)} XLM`;
            if (claimed) m = `🎉 Claimed ${claimed} waiting payment(s)!\n` + m;
            await i.followUp({ content: m, ephemeral: true });
          } catch (e) { await i.followUp({ content: '⚠️ Funding snag — try /deposit.', ephemeral: true }).catch(() => {}); }
        })();
        return;
      }
      const bal = await stellar.balances(w.public_key);
      await i.editReply(`✅ Wallet ready!\n**${bal.USDC} USDC** · ${parseFloat(bal.XLM).toFixed(1)} XLM\n\`${w.public_key}\``);
      claimHeldFor('discord', handle, i.user.id);
      return;
    }
    if (c === 'balance') { const w = await getWallet(handle, 'discord'); if (!w) return i.reply({ content: 'Use /start first.', ephemeral: true }); return i.reply({ content: await discordBalanceText(w), ephemeral: true }); }
    if (c === 'linkpollar') {
      const w = await getWallet(handle, 'discord'); if (!w) return i.reply({ content: 'Use /start first.', ephemeral: true });
      const addr = (i.options.getString('address') || '').toUpperCase();
      if (!STELLAR_ADDR.test(addr)) return i.reply({ content: 'That is not a valid Stellar G-address.', ephemeral: true });
      await execute('UPDATE tagly_wallets SET linked_pollar=? WHERE platform=? AND handle=?', [addr, 'discord', handle]);
      const pb = await stellar.balances(addr).catch(() => ({ USDC: '?', XLM: '?' }));
      return i.reply({ content: `🔗 **Linked!** Your Pollar wallet is connected.\n\`${addr}\`\n${pb.USDC} USDC · ${parseFloat(pb.XLM).toFixed(1)} XLM\n\nBot keeps signing in-chat; use \`/withdraw\` or \`/sweep\` to cash out here.`, ephemeral: true });
    }
    if (c === 'linkemail') {
      const w = await getWallet(handle, 'discord'); if (!w) return i.reply({ content: 'Use /start first.', ephemeral: true });
      const email = (i.options.getString('email') || '').toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return i.reply({ content: 'That is not a valid email.', ephemeral: true });
      return i.reply({ content: await resolveEmailLink('discord', handle, email), ephemeral: true });
    }
    if (c === 'sweep') {
      const w = await getWallet(handle, 'discord'); if (!w) return i.reply({ content: 'Use /start first.', ephemeral: true });
      if (!w.linked_pollar) return i.reply({ content: 'Link your Pollar wallet first with /linkpollar.', ephemeral: true });
      const bal = await stellar.balances(w.public_key);
      const spendable = Math.max(0, parseFloat(bal.XLM) - 2);
      if (spendable < 0.5) return i.reply({ content: `Not enough spendable XLM (balance ${parseFloat(bal.XLM).toFixed(1)}).`, ephemeral: true });
      const amt = spendable.toFixed(4);
      const batchId = await createWithdrawal('discord', handle, w.public_key, w.linked_pollar, amt, 'XLM', i.id);
      batchCtx.set(batchId, { platform: 'discord', channelId: i.channelId, senderHandle: handle });
      const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('dverify:' + batchId).setLabel('✅ Authorize').setStyle(ButtonStyle.Success), new ButtonBuilder().setCustomId('dcancel:' + batchId).setLabel('✖ Cancel').setStyle(ButtonStyle.Secondary));
      return i.reply({ content: `🧹 **Sweep ${amt} XLM** → your Pollar wallet\n\`${w.linked_pollar}\`\nTap **Authorize** for your one-time code.`, components: [row] });
    }
    if (c === 'deposit') { const w = await getWallet(handle, 'discord'); if (!w) return i.reply({ content: 'Use /start first.', ephemeral: true }); const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('dfaucet').setLabel('🚰 Get 100 USDC (real)').setStyle(ButtonStyle.Primary)); return i.reply({ content: `💰 **Deposit**\nSend USDC/XLM (Stellar testnet) to:\n\`${w.public_key}\`\nAppears in your balance automatically.`, components: [row], ephemeral: true }); }
    if (c === 'help') { return i.reply({ content: '**Tagly** — tag someone, pay them.\n`/start` `/balance` `/deposit` `/pay` `/linkpollar` `/linkemail` `/sweep` `/withdraw`\nOr just: `@Tagly send 5 USDC to @user`', ephemeral: true }); }
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
      const amount = i.options.getNumber('amount'); const asset = (i.options.getString('asset') || 'XLM').toUpperCase();
      const addr = (i.options.getString('address') || w.linked_pollar || '').toUpperCase();
      if (!STELLAR_ADDR.test(addr)) return i.reply({ content: 'Provide a Stellar G-address, or /linkpollar first to default to your Pollar wallet.', ephemeral: true });
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
  async function discordBalanceText(w) {
    const bal = await stellar.balances(w.public_key);
    let m = `💳 **Tagly wallet** (custodial)\n**${bal.USDC} USDC** · ${parseFloat(bal.XLM).toFixed(1)} XLM\n\`${w.public_key}\``;
    if (w.linked_pollar) {
      const pb = await stellar.balances(w.linked_pollar).catch(() => ({ USDC: '?', XLM: '?' }));
      m += `\n\n🔗 **Pollar wallet** (self-custody)\n**${pb.USDC} USDC** · ${parseFloat(pb.XLM).toFixed(1)} XLM\n\`${w.linked_pollar}\``;
    } else {
      m += `\n\n🔗 Link your Pollar wallet: \`tagly linkpollar <G-address>\``;
    }
    return m;
  }

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
        let w; try { w = await createUserWallet(handle, msg.author.id, 'discord'); } catch (e) { return msg.reply('⚠️ ' + e.message); }
        if (w.isNew) {
          await msg.reply(`✅ **Wallet created!**\n\`${w.public_key}\`\n⏳ Funding on Stellar — I'll ping you in ~10s.`);
          (async () => {
            try {
              await stellar.fundWallet(w.secret_key);
              await execute("UPDATE tagly_wallets SET funded=1, trustline=1 WHERE platform='discord' AND handle=?", [handle]);
              const { claimed } = await claimHeldFor('discord', handle, msg.author.id);
              const bal = await stellar.balances(w.public_key);
              let m = `💰 **Funded!** ${bal.USDC} USDC · ${parseFloat(bal.XLM).toFixed(1)} XLM\nPay: \`@Tagly send 5 USDC to @friend\``;
              if (claimed) m = `🎉 Claimed ${claimed} waiting payment(s)!\n\n` + m;
              await msg.channel.send(m);
            } catch (e) { await msg.channel.send('⚠️ Funding snag — try `tagly deposit`.').catch(() => {}); }
          })();
        } else {
          const bal = await stellar.balances(w.public_key);
          await msg.reply(`✅ Wallet ready!\n**${bal.USDC} USDC** · ${parseFloat(bal.XLM).toFixed(1)} XLM\n\`${w.public_key}\``);
          claimHeldFor('discord', handle, msg.author.id).then(({ claimed }) => { if (claimed) msg.channel.send(`🎉 Claimed ${claimed} waiting payment(s)!`).catch(() => {}); }).catch(() => {});
        }
        return;
      }
      if (/^balance\b/.test(cmd)) {
        const w = await getWallet(handle, 'discord'); if (!w) return msg.reply('No wallet yet — DM `tagly start`.');
        return msg.reply(await discordBalanceText(w));
      }
      if (/^linkpollar\b/.test(cmd)) {
        const w = await getWallet(handle, 'discord'); if (!w) return msg.reply('Create a wallet first: `tagly start`.');
        const addr = ((msg.content || '').replace(/<@!?\d+>/g, '').trim().split(/\s+/).find(a => STELLAR_ADDR.test(a)) || '').toUpperCase();
        if (!STELLAR_ADDR.test(addr)) return msg.reply('Usage: `tagly linkpollar <your Pollar G-address>`\nCopy it from the Tagly web app → Connect Pollar. Links your self-custody Pollar wallet (unified balance + cash-out); the bot keeps signing in-chat.');
        await execute('UPDATE tagly_wallets SET linked_pollar=? WHERE platform=? AND handle=?', [addr, 'discord', handle]);
        const pb = await stellar.balances(addr).catch(() => ({ USDC: '?', XLM: '?' }));
        return msg.reply(`🔗 **Linked!** Your Pollar wallet is connected.\n\`${addr}\`\n${pb.USDC} USDC · ${parseFloat(pb.XLM).toFixed(1)} XLM\n\n• \`tagly balance\` shows both\n• \`tagly withdraw <amount>\` cashes out here\n• \`tagly sweep\` moves your XLM here`);
      }
      if (/^sweep\b/.test(cmd)) {
        const w = await getWallet(handle, 'discord'); if (!w) return msg.reply('`tagly start` first.');
        if (!w.linked_pollar) return msg.reply('Link your Pollar wallet first: `tagly linkpollar <G-address>`');
        const bal = await stellar.balances(w.public_key);
        const spendable = Math.max(0, parseFloat(bal.XLM) - 2);
        if (spendable < 0.5) return msg.reply(`Not enough spendable XLM to sweep (balance ${parseFloat(bal.XLM).toFixed(1)}).`);
        const amt = spendable.toFixed(4);
        const batchId = await createWithdrawal('discord', handle, w.public_key, w.linked_pollar, amt, 'XLM', msg.id);
        batchCtx.set(batchId, { platform: 'discord', channelId: msg.channel.id, senderHandle: handle });
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('dverify:' + batchId).setLabel('✅ Authorize').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId('dcancel:' + batchId).setLabel('✖ Cancel').setStyle(ButtonStyle.Secondary));
        return msg.reply({ content: `🧹 **Sweep ${amt} XLM** → your Pollar wallet\n\`${w.linked_pollar}\`\nTap **Authorize** for your one-time code.`, components: [row] });
      }
      if (/^deposit\b/.test(cmd)) {
        const w = await getWallet(handle, 'discord'); if (!w) return msg.reply('DM `tagly start` first.');
        const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('dfaucet').setLabel('🚰 Get 100 USDC (real)').setStyle(ButtonStyle.Primary));
        return msg.reply({ content: `💰 **Deposit**\nSend USDC/XLM (Stellar testnet) to:\n\`${w.public_key}\`\nAppears in your balance automatically.`, components: [row] });
      }
      if (/^linkemail\b/.test(cmd)) {
        const w = await getWallet(handle, 'discord'); if (!w) return msg.reply('`tagly start` first.');
        const email = ((msg.content || '').replace(/<@!?\d+>/g, '').trim().split(/\s+/).find(a => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a)) || '').toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return msg.reply('Usage: `tagly linkemail you@example.com` — use the same email as your Pollar login and I auto-connect your wallet.');
        return msg.reply(await resolveEmailLink('discord', handle, email));
      }
      if (/^withdraw\b/.test(cmd)) {
        const w = await getWallet(handle, 'discord'); if (!w) return msg.reply('DM `tagly start` first.');
        const toks = (msg.content || '').replace(/<@!?\d+>/g, '').trim().split(/\s+/);
        const addr = toks.find(a => STELLAR_ADDR.test(a)) || w.linked_pollar;
        const amt = toks.find(a => /^\d+(\.\d+)?$/.test(a));
        const asset = (toks.find(a => /^(usdc|xlm)$/i.test(a)) || 'XLM').toUpperCase();
        if (!addr || !amt) return msg.reply('Usage: `tagly withdraw <G-address> <amount> [XLM|USDC]`\nOr `tagly linkpollar` first, then `tagly withdraw <amount>`. XLM works everywhere.');
        const batchId = await createWithdrawal('discord', handle, w.public_key, addr, amt, asset, msg.id);
        batchCtx.set(batchId, { platform: 'discord', channelId: msg.channel.id, senderHandle: handle });
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('dverify:' + batchId).setLabel('✅ Authorize').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId('dcancel:' + batchId).setLabel('✖ Cancel').setStyle(ButtonStyle.Secondary));
        return msg.reply({ content: `🏦 **Withdraw ${amt} ${asset}**\nTo: \`${addr}\`\nTap **Authorize** for your one-time code.`, components: [row] });
      }
      if (/^help\b/.test(cmd) || cmd === '') {
        return msg.reply('**Tagly** — tag someone, pay them.\n`tagly start` · `tagly balance` · `tagly deposit` · `tagly linkpollar <addr>` · `tagly linkemail <email>` · `tagly sweep` · `tagly withdraw`\nPay: `@Tagly send 5 USDC to @user` · `@Tagly split 30 USDC with @a @b @c`\nOr slash: `/start` `/pay` `/balance` `/linkpollar` `/sweep` `/withdraw`');
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
        await i.reply({ content: 'Swapping XLM → 100 USDC…', ephemeral: true });
        try { await stellar.faucet(w.secret_key, '100'); const bal = await stellar.balances(w.public_key); await i.followUp({ content: `🚰 +100 real USDC! Balance: **${bal.USDC} USDC**`, ephemeral: true }); }
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
app.get('/health', (req, res) => res.json({ ok: true, bot: BOT_USERNAME, polling: (() => { try { return bot.isRunning(); } catch (e) { return null; } })(), issuer: stellar.issuerPublic(), llm: agent.available() ? agent.MODEL : null, discord: discordClient ? (discordClient.user ? discordClient.user.tag : 'connecting') : 'off', discordId: discordClient && discordClient.user ? discordClient.user.id : null }));

(async () => {
  await stellar.initIssuer();
  const me = await bot.api.getMe();
  BOT_USERNAME = me.username;
  app.listen(process.env.PORT, () => console.log('status on', process.env.PORT));
  startDiscord();

  // Self-healing long-polling. A transient network blip can drop grammY's poll
  // loop; the process stays up (health server alive) but the bot goes deaf. So
  // we (a) catch any start() rejection and (b) run a watchdog that relaunches
  // whenever isRunning() flips false — the bot recovers on its own within ~20s.
  const POLL = { allowed_updates: ['message', 'callback_query', 'message_reaction'], onStart: (i) => console.log('bot @' + i.username + ' polling, llm=' + agent.available()) };
  const launch = () => {
    try { bot.start(POLL).catch((e) => console.error('polling stopped:', (e && e.message) || e)); }
    catch (e) { console.error('launch err:', (e && e.message) || e); }
  };
  launch();
  setInterval(() => {
    try { if (!bot.isRunning()) { console.warn('watchdog: polling down — relaunching'); launch(); } }
    catch (e) { console.error('watchdog err:', (e && e.message) || e); }
  }, 20000);
})();

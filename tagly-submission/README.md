# Tagly — Tag someone. Pay them.

Tagly turns a social-media tag into a payment. Mention the bot in a chat — *"@Tagly send 5 USDC to @alice"* — and Tagly parses the intent, resolves the recipient, and settles the payment on **Stellar**, gated by a one-time code you approve. Agentic payments with human-in-the-loop confirmation.

Built for the Pollar / Boundless hackathon.

## Try it live
- **Telegram:** https://t.me/Taglypay_bot — DM `/start`, then `@Taglypay_bot send 5 XLM to @friend`
- **Discord:** invite the bot, then `/start` and `/pay` (or `@Tagly send 5 USDC to @user`)
- **Web app (Pollar):** a social-feed demo with real Pollar login + Stellar wallets

## What it does
- **Natural-language payments** — an LLM agent (Groq) turns free text into a validated payment plan: `send`, `tip`, `split`, and programmable gift-splits ("gift 10 USDC to @a and @b, 70/30").
- **One-time-code authorization** — the sender reacts ✅ / taps Authorize → the bot DMs a single-use code (3-min expiry) → entering it settles the payment. Only the sender can authorize.
- **Account abstraction** — pay a handle that has no wallet yet; the payment is held and lands automatically when they onboard (or via a claim link).
- **Custodial Stellar wallets** — each user gets a testnet wallet (Tagly runs its own USDC issuer so USDC payments are genuinely on-chain and verifiable on stellar.expert).
- **Multi-platform** — one shared engine (wallets, issuer, DB, agent, OTP) behind Telegram **and** Discord adapters.
- **Cross-platform identity** — link X (verified by posting a coded tweet), Instagram, etc. to one wallet.
- **Withdraw / cash-out** — move funds to any external Stellar address (e.g. a self-custody Pollar wallet).
- **Notifications** — recipients are pinged on receipt; senders on claim/expiry.
- **Pollar integration (web app)** — real Pollar login (Google/email) → Stellar USDC wallet, `runTx` payments client-side.

## Architecture
```
Telegram (grammy) ─┐
Discord (discord.js)─┼─► shared engine ──► Stellar testnet (custodial wallets + Tagly USDC issuer)
Web app (Next.js) ──┘     • command parser + Groq agent brain
                          • one-time-code auth (single-use, expiring)
                          • SQLite (identities, wallets, intents, ledger)
Web app also uses the Pollar SDK (@pollar/react) for real Pollar wallets/logins.
```

## Repo layout
- `bot/` — Telegram + Discord bot (Node, grammy + discord.js + @stellar/stellar-sdk). One process, both platforms.
  - `server.js` — all handlers + the shared engine
  - `lib/stellar.js` — custodial wallets, Tagly USDC issuer, transfers, faucet
  - `lib/agent.js` — Groq natural-language payment planner (strictly validated)
  - `lib/parser.js` — rule-based command grammar (fallback)
  - `lib/xverify.js` — X ownership verification via a coded tweet
  - `lib/pdb.js` — DB access
- `web/` — Next.js web app (the social-feed demo + Pollar integration)

## Run the bot
```bash
cd bot
npm install
cp .secrets.example.json .secrets.json   # add your Telegram bot token
# set env: DISCORD_TOKEN (optional), GROQ_API_KEY (optional, for NL agent)
node server.js
```
`lib/pdb.js` expects a Dashboard API (the hosting platform's DB proxy) via `DASHBOARD_BASE` / `DASHBOARD_TOKEN` / `ARTIFACT_GROUP`. Swap it for any SQLite/Postgres layer to self-host.

## Run the web app
```bash
cd web
npm install
cp .env.example .env.local   # add NEXT_PUBLIC_POLLAR_PUBLISHABLE_KEY (pub_testnet_...)
npm run build && node start.js
```

## Notes
- Everything runs on **Stellar testnet** — no real funds.
- The publishable Pollar key is client-side by design; the bot token, issuer secret, and wallet keys are server-side only and are **not** included in this repo.

Built with Claude on Emblem:build.

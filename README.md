# Tagly — Payments, wherever and whenever you tag.

Tagly turns a social-media tag into a payment. Mention the bot in a chat — *"@Tagly send 5 USDC to @alice"* — and Tagly parses the intent, resolves the recipient, and settles the payment on **Solana**, gated by a one-time code you approve. **Agentic payments with human-in-the-loop confirmation.**

Built for the **Colosseum Crypto World's Fair** hackathon.

## Try it live
- **Telegram:** https://t.me/Taglypay_bot — DM `/start`, then `@Taglypay_bot send 5 USDC to @friend`
- **Natural language:** `@Taglypay_bot toss alice 3 bucks and split 10 between bob and carol`

## On-chain proof (Solana devnet)
Payments are real SPL-token transfers, verifiable on Solana:
- **Tagly USDC mint:** [`BfBJ8L9nqzb6j3zWmB7xxKhP9hnVFkttVucpWyXiDAGA`](https://solscan.io/token/BfBJ8L9nqzb6j3zWmB7xxKhP9hnVFkttVucpWyXiDAGA?cluster=devnet)
- **Example payment tx:** [`54eLCq6Cye…X3HyasD`](https://solscan.io/tx/54eLCq6Cye99Uj6J4Ag95Ka59dAh6xxC8pVETupn1ZYhRbrXdEpzoAS2jgYpr62d6CTorJrNJMEwqc8rYX3HyasD?cluster=devnet)

## What it does
- **Natural-language payments** — an LLM agent (Groq) turns free text into a validated payment plan: `send`, `tip`, `split`, and programmable gift-splits ("gift 10 USDC to @a and @b, 70/30"). A rule-based grammar is the always-on fallback.
- **One-time-code authorization** — the sender reacts ✅ / taps Authorize → the bot DMs a single-use code (3-min expiry) → entering it settles the payment. **Only the sender can authorize**, and the LLM can never move money — it only *plans*; every plan is strictly validated server-side.
- **Account abstraction** — pay a handle that has no wallet yet; the payment is held and lands automatically when they onboard via a claim link.
- **Custodial Solana wallets** — each user gets a devnet wallet. Tagly runs its **own SPL "USDC" mint** (6 decimals), so USDC payments are genuinely on-chain and verifiable on solscan.
- **Hard balance guard** — a payment can never exceed the sender's real on-chain balance (no overspend, no minting on the payment path).
- **Multi-platform** — one shared engine (wallets, mint, DB, agent, OTP) behind Telegram **and** Discord adapters.
- **Cross-platform identity** — link X (verified by posting a coded tweet), Instagram, etc. to one wallet.
- **Withdraw / cash-out** — move funds to any external Solana address (e.g. a Phantom wallet).
- **Transaction history** — `/history` lists recent sent/received payments with solscan links.
- **Notifications** — recipients are pinged on receipt; senders on claim/expiry.

## Architecture
```
Telegram (grammy) ─┐
Discord (discord.js)─┼─► shared engine ──► Solana devnet (custodial wallets + Tagly SPL "USDC" mint)
                   ─┘     • command parser + Groq agent brain (plan-only, strictly validated)
                          • one-time-code auth (single-use, expiring)
                          • hard on-chain balance guard
                          • SQLite (identities, wallets, intents, ledger)
```

## Repo layout
- `bot/` — Telegram + Discord bot (Node, grammy + discord.js + @solana/web3.js + @solana/spl-token). One process, both platforms.
  - `server.js` — all handlers + the shared engine
  - `lib/solana.js` — custodial wallets, Tagly SPL USDC mint/treasury, transfers, faucet
  - `lib/agent.js` — Groq natural-language payment planner (strictly validated)
  - `lib/parser.js` — rule-based command grammar (fallback)
  - `lib/xverify.js` — X ownership verification via a coded tweet
  - `lib/pdb.js` — DB access
  - `schema.sql` — canonical DB schema

## Run the bot
```bash
cd bot
npm install
cp .secrets.example.json .secrets.json   # add your Telegram bot token (+ optional GROQ_API_KEY)
cp .env.example .env                      # set SOLANA_RPC (a free Helius devnet key works great)
# apply schema.sql to your DB (see lib/pdb.js for the storage layer)
node server.js
```
On first run the bot auto-creates a treasury wallet + the SPL USDC mint (persisted to `.tagly-solana.json`). Fund the treasury with a little devnet SOL (it pays fees + seeds user wallets).

## How settlement works
1. Sender tags the bot → agent/parser builds a validated plan → bot shows the payment + **Authorize** button.
2. Sender reacts ✅ → bot DMs a single-use 6-digit code (3-min expiry).
3. Sender replies with the code → bot checks the sender's on-chain balance, then signs the custodial SPL transfer on Solana devnet.
4. Recipient is notified; if they have no wallet yet, the amount is held and claimable via link.

## Notes
- Everything runs on **Solana devnet** — no real funds. The same code points at mainnet by swapping the RPC + using a real USDC mint.
- The Telegram bot token, treasury key, and mint authority are server-side only and are **not** included in this repo (`.gitignore`d).

Built with Claude on Emblem:build.

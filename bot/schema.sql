-- Tagly bot schema (SQLite). The canonical source of truth for the DB layout.
-- On Emblem:build the agent applies this via MCP db_execute (the Dashboard API
-- blocks CREATE/ALTER for app servers). Self-hosting: run this against your DB.

CREATE TABLE IF NOT EXISTS tagly_wallets (
  platform    TEXT NOT NULL,
  tg_id       TEXT,
  handle      TEXT NOT NULL,
  public_key  TEXT,
  secret_key  TEXT,
  funded      INTEGER DEFAULT 0,
  trustline   INTEGER DEFAULT 0,   -- legacy flag (Solana has no trustlines; kept for compat)
  linked_pollar TEXT,              -- linked self-custody (Phantom) address
  email       TEXT,
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(platform, handle)
);

CREATE TABLE IF NOT EXISTS tagly_identities (
  platform      TEXT NOT NULL,
  handle        TEXT NOT NULL,
  tg_id         TEXT,
  pollar_address TEXT,             -- the user's Tagly/linked wallet address
  display_name  TEXT,
  verified      INTEGER DEFAULT 0,
  onboarded     INTEGER DEFAULT 0,
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(platform, handle)
);

CREATE TABLE IF NOT EXISTS tagly_intents (
  id              TEXT PRIMARY KEY,
  platform        TEXT,
  source_platform TEXT,
  batch_id        TEXT,
  source_handle   TEXT,
  source_address  TEXT,
  dest_handle     TEXT,
  dest_address    TEXT,
  dest_tg_id      TEXT,
  dest_platform   TEXT,
  action          TEXT,
  amount          TEXT,
  asset_code      TEXT,
  raw_command     TEXT,
  memo            TEXT,
  status          TEXT DEFAULT 'pending',   -- pending|claimable|executed|failed|expired
  idempotency_key TEXT,
  claim_expires_at TIMESTAMP,
  tx_hash         TEXT,            -- on-chain signature once settled
  executed_at     TIMESTAMP,
  error           TEXT,            -- failure reason when status='failed'
  created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_intents_batch   ON tagly_intents(batch_id);
CREATE INDEX IF NOT EXISTS idx_intents_dest    ON tagly_intents(dest_handle, status);
CREATE INDEX IF NOT EXISTS idx_intents_idem    ON tagly_intents(idempotency_key);

CREATE TABLE IF NOT EXISTS tagly_feed (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  platform      TEXT,
  author_handle TEXT,
  text          TEXT,
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS tagly_pollar_links (
  email      TEXT,
  address    TEXT,
  name       TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

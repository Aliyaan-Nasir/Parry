-- Parry's service database. Everything here can be recomputed from the chain (the indexer) and the
-- markets (the monitor), except per-person settings, alerts and push subscriptions.

CREATE TABLE IF NOT EXISTS accounts (
  account       TEXT PRIMARY KEY,
  owner_kind    TEXT NOT NULL,
  owner_id      TEXT NOT NULL,
  hl_address    TEXT,
  evm_address   TEXT,
  created_tx    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS accounts_owner ON accounts (owner_id);

CREATE TABLE IF NOT EXISTS prices (
  asset   TEXT NOT NULL,
  source  TEXT NOT NULL,
  t       TIMESTAMPTZ NOT NULL,
  price   DOUBLE PRECISION NOT NULL,
  PRIMARY KEY (asset, source, t)
);

CREATE TABLE IF NOT EXISTS positions (
  id              TEXT PRIMARY KEY,
  account         TEXT NOT NULL,
  venue           TEXT NOT NULL,
  label           TEXT NOT NULL,
  raw             JSONB NOT NULL,
  collateral_usd  DOUBLE PRECISION NOT NULL,
  debt_usd        DOUBLE PRECISION NOT NULL,
  health          DOUBLE PRECISION,
  liq_price       DOUBLE PRECISION,
  distance        DOUBLE PRECISION NOT NULL DEFAULT 1,
  score           INTEGER NOT NULL DEFAULT 0,
  tier            TEXT NOT NULL DEFAULT 'safe',
  p24             DOUBLE PRECISION NOT NULL DEFAULT 0,
  ttl_hours       DOUBLE PRECISION,
  var99           DOUBLE PRECISION NOT NULL DEFAULT 0,
  read_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  scored_at       TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS positions_account ON positions (account);

CREATE TABLE IF NOT EXISTS position_history (
  position_id  TEXT NOT NULL,
  t            TIMESTAMPTZ NOT NULL,
  health       DOUBLE PRECISION,
  score        INTEGER NOT NULL,
  price        DOUBLE PRECISION NOT NULL,
  PRIMARY KEY (position_id, t)
);

CREATE TABLE IF NOT EXISTS alerts (
  id          BIGSERIAL PRIMARY KEY,
  account     TEXT NOT NULL,
  kind        TEXT NOT NULL,
  severity    TEXT NOT NULL,
  key         TEXT NOT NULL,
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open',
  delivered   BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS alerts_open_key ON alerts (account, key) WHERE status <> 'resolved';

CREATE TABLE IF NOT EXISTS settings (
  account           TEXT PRIMARY KEY,
  thresholds        JSONB NOT NULL DEFAULT '{"score":50,"health":1.25,"cascade":0.5}',
  display_currency  TEXT NOT NULL DEFAULT 'USD',
  telegram_chat_id  TEXT,
  telegram_code     TEXT,
  email             TEXT,
  digest            TEXT NOT NULL DEFAULT 'off',
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint    TEXT PRIMARY KEY,
  account     TEXT NOT NULL,
  keys        JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS guardian_queue (
  account      TEXT PRIMARY KEY,
  reason       TEXT NOT NULL,
  queued_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_run_at  TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS decisions (
  id                  TEXT PRIMARY KEY,
  account             TEXT NOT NULL,
  venue               TEXT NOT NULL,
  action              TEXT NOT NULL,
  plan                TEXT NOT NULL,
  trigger             JSONB NOT NULL,
  outcome             TEXT NOT NULL,
  review              JSONB NOT NULL,
  envelope            TEXT,
  envelope_signature  TEXT,
  txs                 JSONB NOT NULL DEFAULT '{}',
  health_before       DOUBLE PRECISION,
  health_after        DOUBLE PRECISION,
  routes              JSONB,
  detail              TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS decisions_account ON decisions (account, created_at DESC);

CREATE TABLE IF NOT EXISTS events (
  receipt_id    TEXT NOT NULL,
  idx           INTEGER NOT NULL,
  tx_hash       TEXT NOT NULL,
  block_height  BIGINT NOT NULL,
  contract      TEXT NOT NULL,
  standard      TEXT NOT NULL,
  event         TEXT NOT NULL,
  data          JSONB NOT NULL,
  block_time    TIMESTAMPTZ,
  PRIMARY KEY (receipt_id, idx)
);
CREATE INDEX IF NOT EXISTS events_contract ON events (contract, block_height DESC);
CREATE INDEX IF NOT EXISTS events_name ON events (standard, event, block_height DESC);

CREATE TABLE IF NOT EXISTS indexer_cursors (
  contract    TEXT PRIMARY KEY,
  last_block  BIGINT NOT NULL DEFAULT 0,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS reports (
  kind        TEXT NOT NULL,
  run_id      BIGINT NOT NULL,
  tx_hash     TEXT,
  payload     JSONB NOT NULL,
  extra       JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, run_id)
);

CREATE TABLE IF NOT EXISTS vault_history (
  t            TIMESTAMPTZ PRIMARY KEY,
  share_price  DOUBLE PRECISION NOT NULL,
  nav          DOUBLE PRECISION NOT NULL,
  score        INTEGER NOT NULL,
  hedged       DOUBLE PRECISION NOT NULL
);

CREATE TABLE IF NOT EXISTS service_status (
  name        TEXT PRIMARY KEY,
  ok          BOOLEAN NOT NULL,
  detail      TEXT NOT NULL,
  checked_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS wallets (
  name        TEXT PRIMARY KEY,
  account     TEXT NOT NULL,
  balance     DOUBLE PRECISION NOT NULL,
  target      DOUBLE PRECISION NOT NULL,
  lanes       JSONB,
  checked_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS auth_sessions (
  token       TEXT PRIMARY KEY,
  account     TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_challenges (
  nonce       TEXT PRIMARY KEY,
  account     TEXT NOT NULL,
  message     TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS usage (
  day    DATE NOT NULL,
  kind   TEXT NOT NULL,
  who    TEXT NOT NULL,
  count  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, kind, who)
);

CREATE TABLE IF NOT EXISTS payments (
  tx_hash     TEXT PRIMARY KEY,
  payer       TEXT NOT NULL,
  amount      TEXT NOT NULL,
  resource    TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS liquidation_watch (
  account     TEXT PRIMARY KEY,
  note        TEXT NOT NULL,
  added_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Watched accounts, health certificates, the liquidation heatmap, alert incidents, and more of
-- the vault's history.

CREATE TABLE IF NOT EXISTS watched (
  owner       TEXT NOT NULL,
  account     TEXT NOT NULL,
  label       TEXT,
  thresholds  JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (owner, account)
);
CREATE INDEX IF NOT EXISTS watched_account ON watched (account);

CREATE TABLE IF NOT EXISTS certificates (
  hash                TEXT PRIMARY KEY,
  account             TEXT NOT NULL,
  reader              TEXT NOT NULL,
  certificate         TEXT NOT NULL,
  signature           TEXT NOT NULL,
  enclave_public_key  TEXT NOT NULL,
  anchor_tx           TEXT,
  outlayer_tx         TEXT,
  issued_by           TEXT NOT NULL,
  expires_at          TIMESTAMPTZ NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS certificates_account ON certificates (account, created_at DESC);

CREATE TABLE IF NOT EXISTS heatmap_accounts (
  network                TEXT NOT NULL,
  account                TEXT NOT NULL,
  collateral_usd         DOUBLE PRECISION NOT NULL,
  debt_usd               DOUBLE PRECISION NOT NULL,
  driver_collateral_usd  DOUBLE PRECISION NOT NULL,
  liq_price              DOUBLE PRECISION,
  health                 DOUBLE PRECISION,
  read_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (network, account)
);

CREATE TABLE IF NOT EXISTS heatmap_cursors (
  network           TEXT PRIMARY KEY,
  next_index        INTEGER NOT NULL DEFAULT 0,
  total             INTEGER NOT NULL DEFAULT 0,
  sweep_started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  swept_at          TIMESTAMPTZ,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS incidents (
  id          BIGSERIAL PRIMARY KEY,
  account     TEXT NOT NULL,
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  severity    TEXT NOT NULL,
  delivered   BOOLEAN NOT NULL DEFAULT false,
  opened_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS incidents_account ON incidents (account, opened_at DESC);
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS incident_id BIGINT;
CREATE INDEX IF NOT EXISTS alerts_incident ON alerts (incident_id);

ALTER TABLE vault_history ADD COLUMN IF NOT EXISTS staking_yield_usd DOUBLE PRECISION;
ALTER TABLE vault_history ADD COLUMN IF NOT EXISTS funding_yield_usd DOUBLE PRECISION;
ALTER TABLE vault_history ADD COLUMN IF NOT EXISTS hedge_ratio DOUBLE PRECISION;
ALTER TABLE vault_history ADD COLUMN IF NOT EXISTS insurance_usd DOUBLE PRECISION;
ALTER TABLE vault_history ADD COLUMN IF NOT EXISTS reserves_root TEXT;
ALTER TABLE vault_history ADD COLUMN IF NOT EXISTS basis_apr DOUBLE PRECISION;
ALTER TABLE vault_history ADD COLUMN IF NOT EXISTS drawdown DOUBLE PRECISION;
ALTER TABLE vault_history ADD COLUMN IF NOT EXISTS margin_ratio DOUBLE PRECISION;

ALTER TABLE decisions ADD COLUMN IF NOT EXISTS explanation JSONB;

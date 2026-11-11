-- Each service's health by the hour: how many times it reported, and how many of those were ok.
-- An hour with no row means the service did not report at all.
CREATE TABLE IF NOT EXISTS service_uptime (
  name    TEXT NOT NULL,
  hour    TIMESTAMPTZ NOT NULL,
  checks  INTEGER NOT NULL DEFAULT 0,
  ok      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (name, hour)
);

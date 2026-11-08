CREATE TABLE IF NOT EXISTS holders (
  address TEXT PRIMARY KEY,
  amount REAL,
  updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS snapshots (
  address TEXT,
  amount REAL,
  snapshot_at INTEGER,
  PRIMARY KEY (address, snapshot_at)
);

CREATE INDEX IF NOT EXISTS idx_snapshots_addr_time ON snapshots(address, snapshot_at);

-- NEW: Credits table for the loyalty system
CREATE TABLE IF NOT EXISTS credits (
  address TEXT PRIMARY KEY,
  balance REAL DEFAULT 0,
  last_claimed_at INTEGER
);

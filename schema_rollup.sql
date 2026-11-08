CREATE TABLE IF NOT EXISTS rollup_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  merkle_root TEXT,
  tx_count INTEGER,
  created_at INTEGER
);

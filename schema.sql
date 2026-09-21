PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS managers (
  pool TEXT NOT NULL,
  manager_code TEXT NOT NULL,
  manager_name TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  sort_order INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (pool, manager_code),
  UNIQUE (pool, sort_order)
);

CREATE INDEX IF NOT EXISTS idx_managers_active_order
  ON managers(pool, active, sort_order);

CREATE TABLE IF NOT EXISTS pool_settings (
  pool TEXT PRIMARY KEY,
  initial_last_manager_code TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS configuration_state (
  config_key TEXT PRIMARY KEY,
  config_version INTEGER NOT NULL CHECK (config_version >= 1),
  config_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS jobs (
  job_id TEXT PRIMARY KEY,
  mode TEXT NOT NULL CHECK (mode IN ('allocate', 'repair')),
  pool TEXT NOT NULL,
  user_id TEXT NOT NULL,
  user_email TEXT NOT NULL,
  manager_code TEXT NOT NULL,
  sequence_number INTEGER,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_http_status INTEGER,
  last_error_code TEXT,
  last_error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  applied_at TEXT,
  dead_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_jobs_pool_user_created
  ON jobs(pool, user_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_pool_sequence
  ON jobs(pool, sequence_number)
  WHERE sequence_number IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_jobs_status_updated
  ON jobs(status, updated_at);

CREATE TABLE IF NOT EXISTS legacy_assignments (
  legacy_id INTEGER PRIMARY KEY AUTOINCREMENT,
  pool TEXT NOT NULL,
  user_id TEXT NOT NULL,
  manager_code TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_legacy_pool_user_created
  ON legacy_assignments(pool, user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS dead_letters (
  dead_letter_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  pool TEXT NOT NULL,
  user_id TEXT NOT NULL,
  manager_code TEXT NOT NULL,
  error_code TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  received_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_dead_letters_job_received
  ON dead_letters(job_id, received_at DESC);

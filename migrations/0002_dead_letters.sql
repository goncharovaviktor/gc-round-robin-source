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

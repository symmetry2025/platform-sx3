-- SX3 schema v1 (minimal, stage 1)

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  closed_at TEXT,
  meta_json TEXT
);

CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  selector_json TEXT NOT NULL,
  assigns_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS attempts (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  issue_id TEXT NOT NULL,
  worktree TEXT NOT NULL,
  status TEXT NOT NULL,
  base_sha TEXT NOT NULL,
  result_sha TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  pid INTEGER,
  heartbeat_at TEXT,
  exit_code INTEGER,
  ok INTEGER,
  deliverables_json TEXT,
  diagnostics_json TEXT
);

CREATE TABLE IF NOT EXISTS deliveries (
  id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  patch_uri TEXT NOT NULL,
  patch_sha256 TEXT NOT NULL,
  patch_size INTEGER NOT NULL,
  deliverables_json TEXT NOT NULL,
  summary_json TEXT
);

CREATE TABLE IF NOT EXISTS check_runs (
  id TEXT PRIMARY KEY,
  delivery_id TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  ok INTEGER,
  report_json TEXT,
  log_uri TEXT
);

CREATE TABLE IF NOT EXISTS checkpoints (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  session_head_sha_local TEXT,
  session_head_sha_remote TEXT,
  synced_worktrees_json TEXT,
  report_json TEXT
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  kind TEXT NOT NULL,
  session_id TEXT,
  attempt_id TEXT,
  delivery_id TEXT,
  checkpoint_id TEXT,
  payload_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);

CREATE TABLE IF NOT EXISTS worktrees (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  path TEXT NOT NULL,
  state_json TEXT,
  last_seen_at TEXT
);


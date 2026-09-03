CREATE TABLE refinery_schema_history(
             version INT4 PRIMARY KEY,
             name VARCHAR(255),
             applied_on VARCHAR(255),
             checksum VARCHAR(255));
CREATE TABLE commands (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  command TEXT NOT NULL,
  cwd TEXT NOT NULL,
  cwd_project_root TEXT,
  shell TEXT NOT NULL,
  exit_code INTEGER,
  duration_ms INTEGER,
  ts_started INTEGER NOT NULL,
  ts_ended INTEGER,
  git_branch TEXT,
  session_id TEXT NOT NULL,
  redacted_at INTEGER
);
CREATE TABLE sqlite_sequence(name,seq);
CREATE INDEX idx_cmd_cwd_prefix     ON commands(cwd, command)               WHERE redacted_at IS NULL;
CREATE INDEX idx_cmd_root_prefix    ON commands(cwd_project_root, command)  WHERE redacted_at IS NULL AND cwd_project_root IS NOT NULL;
CREATE INDEX idx_cmd_global_prefix  ON commands(command)                    WHERE redacted_at IS NULL;
CREATE INDEX idx_cmd_session_open   ON commands(session_id, ts_started)     WHERE exit_code IS NULL;
CREATE INDEX idx_cmd_ts             ON commands(ts_started);
CREATE TABLE denylist_patterns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  pattern TEXT NOT NULL UNIQUE,
  added_at INTEGER NOT NULL
);
CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE agent_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  workspace_id TEXT,
  cwd TEXT NOT NULL,
  agent_id TEXT,
  native_session_id TEXT,
  resume_command TEXT,
  spawn_command TEXT,
  title TEXT,
  last_prompt TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  ts_started INTEGER NOT NULL,
  ts_updated INTEGER NOT NULL,
  ts_ended INTEGER
, config_dir TEXT, transcript_path TEXT, pane_id TEXT, app_instance TEXT);
CREATE INDEX idx_agent_sessions_status ON agent_sessions(status, ts_updated);
CREATE INDEX idx_agent_sessions_workspace ON agent_sessions(workspace_id, ts_updated);
CREATE INDEX idx_agent_sessions_session_active ON agent_sessions(session_id, status, ts_started);
CREATE TABLE command_stats (
  cwd TEXT NOT NULL,
  command TEXT NOT NULL,
  cwd_project_root TEXT,
  total_count INTEGER NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL DEFAULT 0,
  distinct_days INTEGER NOT NULL DEFAULT 0,
  last_day INTEGER NOT NULL DEFAULT 0,
  first_used INTEGER NOT NULL DEFAULT 0,
  last_used INTEGER NOT NULL DEFAULT 0,
  last_branch TEXT,
  dismissed_count INTEGER NOT NULL DEFAULT 0,
  last_dismissed_at INTEGER,
  last_decayed_at INTEGER,
  PRIMARY KEY (cwd, command)
) WITHOUT ROWID;
CREATE INDEX idx_stats_root      ON command_stats(cwd_project_root, command) WHERE cwd_project_root IS NOT NULL;
CREATE INDEX idx_stats_command   ON command_stats(command);
CREATE INDEX idx_stats_last_used ON command_stats(last_used);
CREATE INDEX idx_agent_sessions_pane
  ON agent_sessions(workspace_id, pane_id, status, ts_updated);

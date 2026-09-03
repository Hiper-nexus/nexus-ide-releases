CREATE TABLE archive_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE chat_threads (id TEXT PRIMARY KEY, updated_at REAL NOT NULL, payload BLOB NOT NULL);
archive_metadata  chat_threads    

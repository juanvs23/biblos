-- Biblos SQLite schema: documents + FTS5, relations, agents, requests.
-- Applied idempotently by src/db/migrate.ts on every boot (all DDL uses IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS documents (
  rowid    INTEGER PRIMARY KEY AUTOINCREMENT,   -- FTS5 external-content rowid
  id       TEXT NOT NULL UNIQUE,                -- uuid v4, public API id
  content  TEXT NOT NULL CHECK(length(content) > 0),
  author   TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  tags     TEXT NOT NULL DEFAULT '[]',          -- JSON array
  project  TEXT,
  type     TEXT NOT NULL DEFAULT 'note'
);

CREATE INDEX IF NOT EXISTS idx_docs_project ON documents(project);

CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
  content, tags,
  content='documents', content_rowid='rowid'
);

-- Keep documents_fts in sync with documents (external-content table).
CREATE TRIGGER IF NOT EXISTS documents_ai AFTER INSERT ON documents BEGIN
  INSERT INTO documents_fts(rowid, content, tags) VALUES (new.rowid, new.content, new.tags);
END;

CREATE TRIGGER IF NOT EXISTS documents_ad AFTER DELETE ON documents BEGIN
  INSERT INTO documents_fts(documents_fts, rowid, content, tags)
    VALUES ('delete', old.rowid, old.content, old.tags);
END;

CREATE TRIGGER IF NOT EXISTS documents_au AFTER UPDATE ON documents BEGIN
  INSERT INTO documents_fts(documents_fts, rowid, content, tags)
    VALUES ('delete', old.rowid, old.content, old.tags);
  INSERT INTO documents_fts(rowid, content, tags) VALUES (new.rowid, new.content, new.tags);
END;



CREATE TABLE IF NOT EXISTS relations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  type      TEXT NOT NULL,
  target_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(source_id, type, target_id)
);

CREATE TABLE IF NOT EXISTS agents (
  name         TEXT PRIMARY KEY,                -- unique identity (REQ-registry)
  type         TEXT NOT NULL,
  capabilities TEXT NOT NULL,                   -- JSON array
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS requests (
  id         TEXT PRIMARY KEY,                  -- uuid v4
  sender     TEXT NOT NULL REFERENCES agents(name),
  recipient  TEXT NOT NULL REFERENCES agents(name),
  payload    TEXT NOT NULL,                     -- JSON
  state      TEXT NOT NULL CHECK(state IN ('pendiente','en-proceso','completada','fallida')),
  result     TEXT,                              -- JSON (completada result | fallida error)
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  claimed_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_requests_recipient_state ON requests(recipient, state, created_at);

-- wiki-schema.sql
-- SQLite FTS5 schema for the wiki index.
--
-- Design notes:
--   * notes          : canonical metadata + content (regular table).
--   * notes_fts      : FTS5 external-content over notes, unicode61 tokenizer.
--                      Good for ASCII / latin tokens (English, code, urls).
--   * notes_tri      : FTS5 external-content over notes, trigram tokenizer.
--                      Handles CJK (Korean in particular) where unicode61
--                      fails to segment word-like tokens.
--   * dirty_flag     : 1-row table that tracks when master-index.md needs
--                      regeneration. Populated by AFTER triggers.
--
-- Query dispatch (performed in wiki-query.sh, not here):
--   * pure ASCII term  -> notes_fts MATCH (unicode61)
--   * contains non-ASCII -> notes_tri MATCH (trigram)
--   * BM25 weighting: title x 3, tags x 2, content x 1
--     (applied via FTS5 "bm25(<table>, w_title, w_tags, w_content)" function)
--
-- External-content mode:
--   FTS5 external-content tables do NOT auto-sync. We install AFTER triggers
--   on `notes` that emit the FTS5 "delete" command followed by a reinsert.
--   This is the canonical pattern from the SQLite FTS5 docs.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- notes : canonical table
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  path        TEXT    UNIQUE NOT NULL,
  title       TEXT    NOT NULL DEFAULT '',
  tags        TEXT    NOT NULL DEFAULT '',   -- space-separated
  type        TEXT    NOT NULL DEFAULT '',   -- concept | source-summary | raw | ...
  source_url  TEXT    NOT NULL DEFAULT '',
  content     TEXT    NOT NULL DEFAULT '',
  mtime       INTEGER NOT NULL DEFAULT 0,
  indexed_at  INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_notes_type ON notes(type);
CREATE INDEX IF NOT EXISTS idx_notes_tags ON notes(tags);
CREATE INDEX IF NOT EXISTS idx_notes_mtime ON notes(mtime);

-- ---------------------------------------------------------------------------
-- notes_fts : unicode61 FTS5 (external-content)
-- ---------------------------------------------------------------------------
CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
  title,
  tags,
  content,
  content='notes',
  content_rowid='id',
  tokenize = "unicode61 remove_diacritics 2"
);

-- ---------------------------------------------------------------------------
-- notes_tri : trigram FTS5 (external-content) — CJK support
-- ---------------------------------------------------------------------------
CREATE VIRTUAL TABLE IF NOT EXISTS notes_tri USING fts5(
  title,
  tags,
  content,
  content='notes',
  content_rowid='id',
  tokenize = "trigram"
);

-- ---------------------------------------------------------------------------
-- dirty_flag : master-index regeneration signal
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dirty_flag (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  dirty       INTEGER NOT NULL DEFAULT 0,
  last_dirty  INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO dirty_flag(id, dirty, last_dirty) VALUES (1, 1, 0);

-- ---------------------------------------------------------------------------
-- Sync triggers : notes -> notes_fts + notes_tri + dirty_flag
-- External-content tables require manual delete-then-insert on UPDATE/DELETE.
-- ---------------------------------------------------------------------------
CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN
  INSERT INTO notes_fts(rowid, title, tags, content)
    VALUES (new.id, new.title, new.tags, new.content);
  INSERT INTO notes_tri(rowid, title, tags, content)
    VALUES (new.id, new.title, new.tags, new.content);
  UPDATE dirty_flag SET dirty = 1, last_dirty = strftime('%s','now') WHERE id = 1;
END;

CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, title, tags, content)
    VALUES ('delete', old.id, old.title, old.tags, old.content);
  INSERT INTO notes_tri(notes_tri, rowid, title, tags, content)
    VALUES ('delete', old.id, old.title, old.tags, old.content);
  UPDATE dirty_flag SET dirty = 1, last_dirty = strftime('%s','now') WHERE id = 1;
END;

CREATE TRIGGER IF NOT EXISTS notes_au AFTER UPDATE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, title, tags, content)
    VALUES ('delete', old.id, old.title, old.tags, old.content);
  INSERT INTO notes_tri(notes_tri, rowid, title, tags, content)
    VALUES ('delete', old.id, old.title, old.tags, old.content);
  INSERT INTO notes_fts(rowid, title, tags, content)
    VALUES (new.id, new.title, new.tags, new.content);
  INSERT INTO notes_tri(rowid, title, tags, content)
    VALUES (new.id, new.title, new.tags, new.content);
  UPDATE dirty_flag SET dirty = 1, last_dirty = strftime('%s','now') WHERE id = 1;
END;

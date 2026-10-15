import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id),
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages(conversation_id);

  -- What checkDiscount returned for a code in this conversation, exactly as the tool returned it.
  -- Written only by the server from a tool result, never from model text or the customer's message;
  -- read back per conversation so the guardrails can allow a true statement about a code that was
  -- verified on an earlier turn (and nothing about one verified in another conversation).
  CREATE TABLE IF NOT EXISTS verified_discounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id),
    code TEXT NOT NULL,
    result TEXT NOT NULL,
    -- Which turn of the conversation (the n-th customer message) the tool ran on. NULL for rows written
    -- before this column existed.
    turn INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_verified_discounts_conversation_id ON verified_discounts(conversation_id);
`;

// dbPath === ':memory:' is used by tests for a fresh, isolated, on-disk-free database.
export function createDb(dbPath) {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }

  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA);
  // A database file made before `turn` existed: add the column, leave old rows NULL.
  const columns = db.prepare('PRAGMA table_info(verified_discounts)').all();
  if (!columns.some((c) => c.name === 'turn')) db.exec('ALTER TABLE verified_discounts ADD COLUMN turn INTEGER');
  return db;
}

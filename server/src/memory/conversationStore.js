const DEFAULT_HISTORY_LIMIT = 20;

// Repository interface over the conversations/messages tables. Takes a
// node:sqlite DatabaseSync instance so tests can pass in a fresh ':memory:'
// database instead of the real one — no mocking required.
export function createConversationStore(db) {
  const getConversationStmt = db.prepare(
    'SELECT id, session_id AS sessionId, created_at AS createdAt FROM conversations WHERE session_id = ?'
  );
  const insertConversationStmt = db.prepare('INSERT INTO conversations (session_id) VALUES (?)');
  const insertMessageStmt = db.prepare(
    'INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)'
  );
  // Selects the most recent `limit` messages, then re-sorts them ascending so
  // the caller always gets chronological order regardless of the limit.
  const getRecentMessagesStmt = db.prepare(`
    SELECT role, content, created_at AS createdAt FROM (
      SELECT id, role, content, created_at
      FROM messages
      WHERE conversation_id = ?
      ORDER BY id DESC
      LIMIT ?
    )
    ORDER BY id ASC
  `);

  function getOrCreateConversation(sessionId) {
    const existing = getConversationStmt.get(sessionId);
    if (existing) return existing;
    insertConversationStmt.run(sessionId);
    return getConversationStmt.get(sessionId);
  }

  function getHistory(sessionId, limit = DEFAULT_HISTORY_LIMIT) {
    const conversation = getConversationStmt.get(sessionId);
    if (!conversation) return [];

    return getRecentMessagesStmt.all(conversation.id, limit).map((row) => ({
      role: row.role,
      content: row.content,
    }));
  }

  function saveMessage(sessionId, role, content) {
    const conversation = getOrCreateConversation(sessionId);
    insertMessageStmt.run(conversation.id, role, content);
  }

  return { getOrCreateConversation, getHistory, saveMessage };
}

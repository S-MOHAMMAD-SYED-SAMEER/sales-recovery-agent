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

  const insertVerifiedStmt = db.prepare(
    'INSERT INTO verified_discounts (conversation_id, code, result, turn) VALUES (?, ?, ?, ?)'
  );
  const getVerifiedTurnsStmt = db.prepare(
    'SELECT code, turn FROM verified_discounts WHERE conversation_id = ? ORDER BY id ASC'
  );
  const countUserMessagesStmt = db.prepare(
    "SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND role = 'user'"
  );
  const getVerifiedStmt = db.prepare(
    'SELECT result FROM verified_discounts WHERE conversation_id = ? ORDER BY id ASC'
  );

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

  // A checkDiscount result, exactly as the tool returned it, kept against THIS conversation.
  // Anything without a string `code` is not a discount verification and is not kept.
  // `turn` is the turn of the conversation it ran on (see countUserMessages), kept beside the result and
  // never inside it, so the result stays exactly what the tool returned.
  function saveVerifiedDiscount(sessionId, result, turn = null) {
    if (!result || typeof result.code !== 'string') return;
    const conversation = getOrCreateConversation(sessionId);
    const safeTurn = Number.isInteger(turn) && turn > 0 ? turn : null;
    insertVerifiedStmt.run(conversation.id, result.code.toUpperCase(), JSON.stringify(result), safeTurn);
  }

  // The turn each code was last verified on, { CODE: turn | null }, this conversation only.
  function getVerifiedTurns(sessionId) {
    const conversation = getConversationStmt.get(sessionId);
    if (!conversation) return {};
    const turns = {};
    for (const row of getVerifiedTurnsStmt.all(conversation.id)) turns[row.code] = row.turn ?? null;
    return turns;
  }

  // How many customer messages this conversation has: the number of the turn that was just saved.
  function countUserMessages(sessionId) {
    const conversation = getConversationStmt.get(sessionId);
    return conversation ? countUserMessagesStmt.get(conversation.id).n : 0;
  }

  // The checkDiscount results from this conversation only, oldest first. An unknown session has none.
  function getVerifiedDiscounts(sessionId) {
    const conversation = getConversationStmt.get(sessionId);
    if (!conversation) return [];
    return getVerifiedStmt.all(conversation.id).map((row) => JSON.parse(row.result));
  }

  // Closing is the only thing here that touches `db` directly, and that is the
  // point of having it: the prepared statements above do not keep the database
  // object alive on Node 22, so a store built as
  // createConversationStore(createDb(':memory:')) could have its database
  // garbage-collected mid-use ("statement has been finalized"). Holding `db` in
  // a closure that lives as long as the store prevents that.
  function close() {
    db.close();
  }

  return {
    getOrCreateConversation,
    getHistory,
    saveMessage,
    saveVerifiedDiscount,
    getVerifiedDiscounts,
    getVerifiedTurns,
    countUserMessages,
    close,
  };
}

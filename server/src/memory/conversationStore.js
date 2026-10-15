const DEFAULT_HISTORY_LIMIT = 20;
const EXCERPT_MAX_CHARS = 120;

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
    'INSERT INTO verified_discounts (conversation_id, code, result, turn, excerpt) VALUES (?, ?, ?, ?, ?)'
  );
  const getVerifiedQuestionsStmt = db.prepare(
    'SELECT code, turn, excerpt FROM verified_discounts WHERE conversation_id = ? ORDER BY id ASC'
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
  // `question` is the number of the customer's question it ran on (see countUserMessages) and `excerpt` a short
  // plain-text piece of it, both kept beside the result and never inside it, so the result stays exactly what the
  // tool returned. A number that is not a positive whole number, or an empty excerpt, is kept as unknown.
  function saveVerifiedDiscount(sessionId, result, question = null, excerpt = null) {
    if (!result || typeof result.code !== 'string') return;
    const conversation = getOrCreateConversation(sessionId);
    const safeQuestion = Number.isInteger(question) && question > 0 ? question : null;
    const safeExcerpt = typeof excerpt === 'string' && excerpt.trim() ? excerpt.replace(/\s+/g, ' ').trim().slice(0, EXCERPT_MAX_CHARS) : null;
    insertVerifiedStmt.run(conversation.id, result.code.toUpperCase(), JSON.stringify(result), safeQuestion, safeExcerpt);
  }

  // Which question each code was last verified on, { CODE: { question, excerpt } }, this conversation only.
  function getVerifiedQuestions(sessionId) {
    const conversation = getConversationStmt.get(sessionId);
    if (!conversation) return {};
    const out = {};
    for (const row of getVerifiedQuestionsStmt.all(conversation.id)) out[row.code] = { question: row.turn ?? null, excerpt: row.excerpt ?? null };
    return out;
  }

  // How many customer messages this conversation has, and so the number of the question that was just saved.
  // Only role 'user' rows count: replies and tool calls between questions never move it.
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
    getVerifiedQuestions,
    countUserMessages,
    close,
  };
}

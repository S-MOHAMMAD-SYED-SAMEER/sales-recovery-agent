import { config } from '../config/env.js';
import { createDb } from './db.js';
import { createConversationStore } from './conversationStore.js';

const db = createDb(config.sqlitePath);

export const conversationStore = createConversationStore(db);

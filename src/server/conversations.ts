import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ChatMessage, Conversation, ConversationSummary, SavedMessage } from '../shared/types.js';
import { AppError } from './errors.js';

export class ConversationStore {
  private readonly db: DatabaseSync;
  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(join(dataDir, 'conversations.sqlite'));
    try {
      this.db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
      this.db.function('casefold', { deterministic: true }, value => String(value).toLocaleLowerCase('ru-RU'));
      if (Number(this.db.prepare('PRAGMA user_version').get()?.user_version) > 1) throw new Error('Newer database');
      this.db.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE IF NOT EXISTS conversations (
          id TEXT PRIMARY KEY, title TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS messages (
          id INTEGER PRIMARY KEY, conversationId TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
          role TEXT NOT NULL CHECK(role IN ('user', 'assistant')), content TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('complete', 'pending', 'interrupted', 'error')), createdAt TEXT NOT NULL
        ) STRICT;
        CREATE INDEX IF NOT EXISTS messages_conversation ON messages(conversationId, id);
        UPDATE messages SET status = 'interrupted' WHERE status = 'pending';
        PRAGMA user_version = 1;
        COMMIT;
      `);
    } catch {
      this.db.close();
      throw new Error('Не удалось открыть data/conversations.sqlite. Сохраните копию файла перед восстановлением.');
    }
  }
  close() { this.db.close(); }
  list(query: string, offset: number): { conversations: ConversationSummary[]; hasMore: boolean } {
    const rows = this.db.prepare(`
      SELECT c.*, (SELECT count(*) FROM messages m WHERE m.conversationId = c.id) AS messageCount
      FROM conversations c WHERE instr(casefold(c.title), casefold(?)) > 0 OR EXISTS (
        SELECT 1 FROM messages m WHERE m.conversationId = c.id AND instr(casefold(m.content), casefold(?)) > 0
      ) ORDER BY c.updatedAt DESC, c.id LIMIT 51 OFFSET ?
    `).all(query, query, offset) as unknown as ConversationSummary[];
    return { conversations: rows.slice(0, 50), hasMore: rows.length > 50 };
  }
  create(): Conversation {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare('INSERT INTO conversations VALUES (?, ?, ?, ?)').run(id, 'Новый разговор', now, now);
    return this.get(id);
  }
  get(id: string): Conversation {
    const row = this.db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
    if (!row) throw new AppError(404, 'Разговор не найден.');
    const messages = this.db.prepare('SELECT role, content, status, createdAt FROM messages WHERE conversationId = ? ORDER BY id').all(id);
    return { ...row, messages } as unknown as Conversation;
  }
  rename(id: string, title: unknown): Conversation {
    if (typeof title !== 'string' || !title.trim() || title.length > 120) throw new AppError(400, 'Название: от 1 до 120 символов.');
    this.get(id);
    this.db.prepare('UPDATE conversations SET title = ?, updatedAt = ? WHERE id = ?').run(title.trim(), new Date().toISOString(), id);
    return this.get(id);
  }
  delete(id: string) {
    this.get(id);
    this.db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
  }
  begin(id: string, content: unknown): { messageId: number; context: ChatMessage[] } {
    if (typeof content !== 'string' || !content.trim() || content.length > 12000) throw new AppError(400, 'Сообщение: от 1 до 12 000 символов.');
    const previous = this.get(id);
    const pending: ChatMessage = { role: 'user', content: content.trim() };
    const context: ChatMessage[] = [];
    let size = pending.content.length;
    // Trimming affects provider context only, never the saved archive.
    for (const message of [...previous.messages].reverse()) {
      if (!message.content || message.status === 'error' || message.status === 'pending') continue;
      if (context.length >= 22 || size + message.content.length > 60000) break;
      context.unshift({ role: message.role, content: message.content });
      size += message.content.length;
    }
    while (context[0]?.role === 'assistant') context.shift();
    context.push(pending);
    const now = new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO messages(conversationId, role, content, status, createdAt) VALUES (?, ?, ?, ?, ?)').run(id, 'user', pending.content, 'complete', now);
      const result = this.db.prepare('INSERT INTO messages(conversationId, role, content, status, createdAt) VALUES (?, ?, ?, ?, ?)').run(id, 'assistant', '', 'pending', now);
      this.db.prepare('UPDATE conversations SET title = ?, updatedAt = ? WHERE id = ?').run(previous.messages.length ? previous.title : pending.content.slice(0, 80), now, id);
      this.db.exec('COMMIT');
      return { messageId: Number(result.lastInsertRowid), context };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  save(messageId: number, content: string, status: SavedMessage['status']) {
    this.db.prepare('UPDATE messages SET content = ?, status = ? WHERE id = ?').run(content, status, messageId);
    this.db.prepare('UPDATE conversations SET updatedAt = ? WHERE id = (SELECT conversationId FROM messages WHERE id = ?)').run(new Date().toISOString(), messageId);
  }
}

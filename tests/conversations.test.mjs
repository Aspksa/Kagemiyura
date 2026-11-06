import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConversationStore } from '../dist/server/conversations.js';

async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), 'kagemiyura-memory-'));
  t.after(() => rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return path;
}
test('reopening the database restores chats and marks unfinished streams as interrupted', async t => {
  const path = await directory(t);
  let store = new ConversationStore(path);
  const conversation = store.create();
  const turn = store.begin(conversation.id, 'Запомни: внешний диск');
  store.save(turn.messageId, 'Часть ответа', 'pending');
  store.close();
  store = new ConversationStore(path);
  try {
    const saved = store.get(conversation.id);
    assert.equal(saved.messages[0].content, 'Запомни: внешний диск');
    assert.equal(saved.messages[1].content, 'Часть ответа');
    assert.equal(saved.messages[1].status, 'interrupted');
    assert.equal(store.list('ВНЕШНИЙ', 0).conversations.length, 1);
  } finally { store.close(); }
});
test('provider context stays bounded while every archived message survives', async t => {
  const store = new ConversationStore(await directory(t));
  try {
    const conversation = store.create();
    for (let index = 0; index < 30; index++) {
      const turn = store.begin(conversation.id, `${index}:` + 'я'.repeat(11990));
      assert.ok(turn.context.length <= 23);
      assert.ok(turn.context.reduce((n, m) => n + m.content.length, 0) <= 60000);
      assert.equal(turn.context[0].role, 'user');
      assert.equal(turn.context.at(-1).role, 'user');
      store.save(turn.messageId, 'Ответ', 'complete');
    }
    assert.equal(store.get(conversation.id).messages.length, 60);
  } finally { store.close(); }
});
test('archive pagination has stable pages and treats search characters literally', async t => {
  const store = new ConversationStore(await directory(t));
  try {
    for (let index = 0; index < 52; index++) store.create();
    const first = store.list('', 0);
    const second = store.list('', 50);
    assert.equal(first.conversations.length, 50);
    assert.equal(first.hasMore, true);
    assert.equal(second.conversations.length, 2);
    assert.equal(second.hasMore, false);
    assert.equal(new Set([...first.conversations, ...second.conversations].map(c => c.id)).size, 52);
    assert.equal(store.list('%', 0).conversations.length, 0);
    assert.equal(store.list("' OR 1=1 --", 0).conversations.length, 0);
  } finally { store.close(); }
});

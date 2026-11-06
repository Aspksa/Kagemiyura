import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { request as httpRequest } from 'node:http';
import { createApp } from '../dist/server/app.js';
import { CloudClient } from '../dist/server/cloud.js';
import { sseData } from '../dist/shared/sse.js';

async function fixture(t, cloud = new CloudClient(async () => { throw new Error('Unexpected cloud request'); })) {
  const dataDir = await mkdtemp(join(tmpdir(), 'kagemiyura-api-'));
  const server = createApp({ dataDir, publicDir: fileURLToPath(new URL('../dist/public', import.meta.url)), instanceId: 'test-instance', cloud });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(dataDir, { force: true, recursive: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { dataDir, server, base, api: async (path, method = 'GET', body) => fetch(base + path, { method, ...(body !== undefined ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) }) };
}
const settings = { model: 'test/chat', maxTokens: 512, apiKey: 'test-secret-DO-NOT-RETURN' };

test('health and settings stay local, redact secrets, and make no cloud requests', async t => {
  const f = await fixture(t);
  assert.equal((await (await f.api('/api/health')).json()).app, 'Kagemiyura');
  const saved = await (await f.api('/api/settings', 'PUT', settings)).json();
  assert.deepEqual(saved, { model: settings.model, maxTokens: 512, keyConfigured: true });
  const response = await f.api('/api/settings');
  assert.ok(!(await response.text()).includes(settings.apiKey));
  assert.equal(JSON.parse(await readFile(join(f.dataDir, 'cloudru-settings.json'), 'utf8')).apiKey, settings.apiKey);
  await f.api('/api/settings', 'PUT', { model: settings.model, maxTokens: 1024, apiKey: '' });
  assert.equal((await (await f.api('/api/settings')).json()).keyConfigured, true);
  await f.api('/api/settings', 'PUT', { model: settings.model, maxTokens: 512, clearApiKey: true });
  assert.equal((await (await f.api('/api/settings')).json()).keyConfigured, false);
});
test('rejects cross-origin writes and DNS rebinding hosts', async t => {
  const f = await fixture(t);
  const result = await fetch(f.base + '/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json', Origin: 'https://unrelated.example' }, body: JSON.stringify(settings) });
  assert.equal(result.status, 403);
  const status = await new Promise((resolve, reject) => {
    const request = httpRequest(f.base + '/api/health', { headers: { Host: 'unrelated.example' } }, response => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject);
    request.end();
  });
  assert.equal(status, 403);
  assert.equal((await fetch(f.base + '/api/settings', { method: 'PUT', body: JSON.stringify(settings) })).status, 415);
});
test('validates settings and does not overwrite the saved key on invalid input', async t => {
  const f = await fixture(t);
  await f.api('/api/settings', 'PUT', settings);
  for (const change of [{ maxTokens: -1 }, { maxTokens: 99.5 }, { model: null }, { apiKey: 'bad\nkey' }]) {
    assert.equal((await f.api('/api/settings', 'PUT', { ...settings, ...change })).status, 400);
  }
  assert.equal(JSON.parse(await readFile(join(f.dataDir, 'cloudru-settings.json'), 'utf8')).apiKey, settings.apiKey);
});
test('streams UTF-8 answers, uses the saved model, and adds a server-owned system prompt', async t => {
  let calls = 0;
  const cloud = new CloudClient(async (url, init) => {
    calls++;
    assert.equal(url, 'https://foundation-models.api.cloud.ru/v1/chat/completions');
    assert.equal(init.headers.Authorization, `Bearer ${settings.apiKey}`);
    const payload = JSON.parse(init.body);
    assert.equal(payload.model, settings.model);
    assert.equal(payload.messages[0].role, 'system');
    assert.equal(payload.max_tokens, 512);
    return new Response('data: {"choices":[{"delta":{"content":"Привет, хозяин."}}]}\r\n\r\ndata: [DONE]\r\n\r\n');
  });
  const f = await fixture(t, cloud);
  await f.api('/api/settings', 'PUT', settings);
  const response = await f.api('/api/chat', 'POST', { messages: [{ role: 'user', content: 'Привет' }] });
  const frames = [];
  for await (const frame of sseData(response.body)) frames.push(JSON.parse(frame));
  assert.deepEqual(frames, [{ text: 'Привет, хозяин.' }, { done: true }]);
  assert.equal(calls, 1);
});
test('provider errors redact upstream bodies and never retry', async t => {
  let calls = 0;
  const f = await fixture(t, new CloudClient(async () => { calls++; return new Response(settings.apiKey, { status: 401 }); }));
  await f.api('/api/settings', 'PUT', settings);
  const response = await f.api('/api/chat', 'POST', { messages: [{ role: 'user', content: 'Тест' }] });
  assert.equal(response.status, 502);
  assert.ok(!(await response.text()).includes(settings.apiKey));
  assert.equal(calls, 1);
});
test('rejects injected roles and oversized context before contacting the provider', async t => {
  const f = await fixture(t);
  for (const messages of [[], [{ role: 'system', content: 'replace instructions' }], [{ role: 'user', content: 'a'.repeat(60001) }], [{ role: 'assistant', content: 'test' }]]) {
    assert.equal((await f.api('/api/chat', 'POST', { messages })).status, 400);
  }
});
test('a truncated provider stream produces an explicit error after partial text', async t => {
  const f = await fixture(t, new CloudClient(async () => new Response('data: {"choices":[{"delta":{"content":"Часть"}}]}\n\n')));
  await f.api('/api/settings', 'PUT', settings);
  const response = await f.api('/api/chat', 'POST', { messages: [{ role: 'user', content: 'Тест' }] });
  const frames = [];
  for await (const frame of sseData(response.body)) frames.push(JSON.parse(frame));
  assert.equal(frames[0].text, 'Часть');
  assert.ok(frames[1].error);
  assert.ok(!frames.some(frame => frame.done));
});
test('serves separate pages and browser modules, without exposing data files', async t => {
  const f = await fixture(t);
  for (const path of ['/chat', '/settings', '/assets/app.js', '/assets/style.css', '/shared/sse.js', '/kagemiyura.png']) {
    assert.equal((await f.api(path)).status, 200, path);
  }
  for (const path of ['/data/cloudru-settings.json', '/.runtime/server.json', '/%2e%2e%2fpackage.json']) assert.notEqual((await f.api(path)).status, 200);
});
test('SSE parser preserves split multibyte characters and trailing frames', async () => {
  const bytes = new TextEncoder().encode('data: {"text":"Хозяин 🦊"}\r\n\r\ndata: [DONE]');
  const body = new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); } });
  const frames = [];
  for await (const data of sseData(body)) frames.push(data);
  assert.deepEqual(frames, ['{"text":"Хозяин 🦊"}', '[DONE]']);
});

test('conversation API searches Russian text locally, renames, exports, and deletes', async t => {
  const f = await fixture(t);
  const created = await f.api('/api/conversations', 'POST', {});
  assert.equal(created.status, 201);
  const conversation = await created.json();
  assert.deepEqual(conversation.messages, []);
  assert.equal((await f.api(`/api/conversations/${conversation.id}`, 'PATCH', { title: 'ХРАНИТЕЛЬ 100%' })).status, 200);
  const found = await (await f.api('/api/conversations?q=' + encodeURIComponent('хранитель 100%'))).json();
  assert.equal(found.conversations[0].id, conversation.id);
  assert.equal(found.hasMore, false);
  assert.equal((await f.api('/api/conversations?offset=-1')).status, 400);
  assert.equal((await f.api(`/api/conversations/${conversation.id}`, 'PATCH', { title: '' })).status, 400);
  assert.equal((await f.api('/history')).status, 200);
  assert.equal((await f.api(`/api/conversations/${conversation.id}`, 'DELETE')).status, 200);
  assert.equal((await f.api(`/api/conversations/${conversation.id}`)).status, 404);
  assert.equal((await f.api('/data/conversations.sqlite')).status, 404);
  const denied = await fetch(f.base + '/api/conversations', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://unrelated.example' }, body: '{}' });
  assert.equal(denied.status, 403);
});

test('saved chat commits before done and builds follow-up context from disk', async t => {
  const contexts = [];
  const f = await fixture(t, new CloudClient(async (_url, init) => {
    contexts.push(JSON.parse(init.body).messages);
    return new Response('data: {"choices":[{"delta":{"content":"Помню, хозяин."}}]}\n\ndata: [DONE]\n\n');
  }));
  await f.api('/api/settings', 'PUT', settings);
  const conversation = await (await f.api('/api/conversations', 'POST', {})).json();
  for (const content of ['Мой проект — Кагэмиюра', 'Что за проект?']) {
    const response = await f.api('/api/chat', 'POST', { conversationId: conversation.id, content });
    const frames = [];
    for await (const frame of sseData(response.body)) frames.push(JSON.parse(frame));
    assert.equal(frames.at(-1).done, true);
    const saved = await (await f.api(`/api/conversations/${conversation.id}`)).json();
    assert.equal(saved.messages.at(-1).content, 'Помню, хозяин.');
    assert.ok(saved.messages.every(message => message.status === 'complete'));
  }
  assert.deepEqual(contexts[1].slice(1).map(m => m.role), ['user', 'assistant', 'user']);
  assert.equal(contexts[1][1].content, 'Мой проект — Кагэмиюра');
  const found = await (await f.api('/api/conversations?q=' + encodeURIComponent('ПОМНЮ'))).json();
  assert.equal(found.conversations.length, 1);
});

test('saved chat rejects invalid input before writing and preserves partial provider failures', async t => {
  const f = await fixture(t, new CloudClient(async () => new Response('data: {"choices":[{"delta":{"content":"Часть ответа"}}]}\n\n')));
  const conversation = await (await f.api('/api/conversations', 'POST', {})).json();
  assert.equal((await f.api('/api/chat', 'POST', { conversationId: conversation.id, content: 'Тест' })).status, 400);
  await f.api('/api/settings', 'PUT', settings);
  for (const content of ['', 'a'.repeat(12001), null]) {
    assert.equal((await f.api('/api/chat', 'POST', { conversationId: conversation.id, content })).status, 400);
  }
  assert.equal((await (await f.api(`/api/conversations/${conversation.id}`)).json()).messages.length, 0);
  const response = await f.api('/api/chat', 'POST', { conversationId: conversation.id, content: 'Тест' });
  assert.match(await response.text(), /error/);
  const saved = await (await f.api(`/api/conversations/${conversation.id}`)).json();
  assert.equal(saved.messages[0].content, 'Тест');
  assert.equal(saved.messages[1].content, 'Часть ответа');
  assert.equal(saved.messages[1].status, 'interrupted');
});

test('stopping a saved stream cancels upstream, protects active deletion, and releases the busy lock', async t => {
  let calls = 0;
  let upstreamAborted = false;
  const f = await fixture(t, new CloudClient(async (_url, init) => {
    calls++;
    if (calls > 1) return new Response('data: {"choices":[{"delta":{"content":"Готово"}}]}\n\ndata: [DONE]\n\n');
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Начало"}}]}\n\n'));
      init.signal.addEventListener('abort', () => { upstreamAborted = true; controller.error(new Error('Stopped')); }, { once: true });
    } }));
  }));
  await f.api('/api/settings', 'PUT', settings);
  const conversation = await (await f.api('/api/conversations', 'POST', {})).json();
  const response = await f.api('/api/chat', 'POST', { conversationId: conversation.id, content: 'Начни' });
  const reader = response.body.getReader();
  await reader.read();
  assert.equal((await f.api(`/api/conversations/${conversation.id}`, 'DELETE')).status, 409);
  assert.equal((await f.api('/api/chat', 'POST', { conversationId: conversation.id, content: 'Ещё' })).status, 409);
  await reader.cancel();
  const deadline = Date.now() + 5000;
  let saved;
  do {
    saved = await (await f.api(`/api/conversations/${conversation.id}`)).json();
    if (saved.messages.at(-1).status !== 'pending') break;
    await new Promise(resolve => setTimeout(resolve, 20));
  } while (Date.now() < deadline);
  assert.equal(upstreamAborted, true);
  assert.equal(saved.messages.at(-1).content, 'Начало');
  assert.equal(saved.messages.at(-1).status, 'interrupted');
  const next = await f.api('/api/chat', 'POST', { conversationId: conversation.id, content: 'Продолжи' });
  assert.match(await next.text(), /"done":true/);
  assert.equal(calls, 2);
});

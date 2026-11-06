import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { once } from 'node:events';
import type { ChatMessage } from '../shared/types.js';
import { SettingsStore } from './settings.js';
import { CloudClient } from './cloud.js';
import { AppError, publicError } from './errors.js';
import { ConversationStore } from './conversations.js';

interface Options { dataDir: string; publicDir: string; instanceId: string; cloud?: CloudClient }
const mime: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
};
export function createApp(options: Options) {
  const settings = new SettingsStore(options.dataDir);
  const cloud = options.cloud ?? new CloudClient();
  const conversations = new ConversationStore(options.dataDir);
  let busy = false;
  let activeConversation: string | undefined;
  const server = createServer((request, response) => { void route(request, response); });
  server.once('close', () => conversations.close());
  server.requestTimeout = 150000;
  server.headersTimeout = 15000;
  const publicDir = resolve(options.publicDir);
  async function route(req: IncomingMessage, res: ServerResponse) {
    const abort = new AbortController();
    res.on('close', () => abort.abort());
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    res.setHeader('Cache-Control', 'no-store');
    try {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
      if (!req.headers.host || !hosts.includes(req.headers.host)) throw new AppError(403, 'Разрешён только локальный доступ.');
      const origin = req.headers.origin;
      if (origin && !hosts.map(host => `http://${host}`).includes(origin)) throw new AppError(403, 'Запрос с другого сайта запрещён.');
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
      const path = url.pathname;
      if (path === '/api/health' && req.method === 'GET') {
        return json(res, 200, { app: 'Kagemiyura', version: '0.2.0', instanceId: options.instanceId, keyConfigured: (await settings.public()).keyConfigured });
      }
      if (path === '/api/settings' && req.method === 'GET') return json(res, 200, await settings.public());
      if (path === '/api/settings' && req.method === 'PUT') return json(res, 200, await settings.update(await body(req)));
      if (path === '/api/models' && req.method === 'GET') {
        return json(res, 200, { models: await cloud.models(await settings.read(), abort.signal) });
      }
      if (path === '/api/connection' && req.method === 'POST') {
        await body(req);
        await cloud.check(await settings.read(), abort.signal);
        return json(res, 200, { message: 'Модель отвечает. Ключ и доступ проверены.' });
      }
      if (path === '/api/conversations' && req.method === 'GET') {
        const query = url.searchParams.get('q') ?? '';
        const offset = Number(url.searchParams.get('offset') ?? '0');
        if (query.length > 200 || !Number.isSafeInteger(offset) || offset < 0) throw new AppError(400, 'Некорректные параметры поиска.');
        return json(res, 200, conversations.list(query, offset));
      }
      if (path === '/api/conversations' && req.method === 'POST') {
        await body(req);
        return json(res, 201, conversations.create());
      }
      const conversationRoute = /^\/api\/conversations\/([a-f0-9-]{36})$/.exec(path);
      if (conversationRoute) {
        const id = conversationRoute[1]!;
        if (req.method === 'GET') return json(res, 200, conversations.get(id));
        if (req.method === 'PATCH') {
          const input = await body(req) as { title?: unknown } | null;
          return json(res, 200, conversations.rename(id, input?.title));
        }
        if (req.method === 'DELETE') {
          if (activeConversation === id) throw new AppError(409, 'Сначала остановите ответ в этом разговоре.');
          conversations.delete(id);
          return json(res, 200, { deleted: true });
        }
        throw new AppError(405, 'Метод не поддерживается.');
      }
      if (path === '/api/chat' && req.method === 'POST') {
        if (busy) throw new AppError(409, 'Ответ уже формируется. Дождитесь завершения или остановите его.');
        const input = await body(req) as Record<string, unknown> | null;
        const id = input?.conversationId;
        if (id !== undefined && (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id))) throw new AppError(400, 'Некорректный разговор.');
        const legacy = id === undefined ? validateMessages(input) : undefined;
        const config = await settings.read();
        if (!config.apiKey || !config.model) throw new AppError(400, 'Сначала сохраните ключ и модель в настройках.');
        if (busy) throw new AppError(409, 'Ответ уже формируется.');
        const turn = typeof id === 'string' ? conversations.begin(id, input?.content) : undefined;
        busy = true;
        activeConversation = typeof id === 'string' ? id : undefined;
        let answer = '';
        let checkpoint = 0;
        let complete = false;
        try {
          // Do not commit SSE headers until configuration has been validated by the generator.
          for await (const text of cloud.chat(config, turn?.context ?? legacy!, abort.signal)) {
            answer += text;
            if (turn && Date.now() - checkpoint >= 500) {
              conversations.save(turn.messageId, answer, 'pending');
              checkpoint = Date.now();
            }
            if (!res.headersSent) res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'X-Accel-Buffering': 'no' });
            if (!res.write(`data: ${JSON.stringify({ text })}\n\n`)) await once(res, 'drain', { signal: abort.signal });
          }
          if (!answer) throw new AppError(502, 'Модель вернула пустой ответ. Попробуйте другую модель.');
          if (turn) conversations.save(turn.messageId, answer, 'complete');
          complete = true;
          if (!res.headersSent) res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
          res.end(`data: ${JSON.stringify({ done: true })}\n\n`);
        } finally {
          try { if (turn && !complete) conversations.save(turn.messageId, answer, answer || abort.signal.aborted ? 'interrupted' : 'error'); }
          finally { busy = false; activeConversation = undefined; }
        }
        return;
      }
      if (path.startsWith('/api/')) throw new AppError(404, 'Метод не найден.');
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new AppError(405, 'Метод не поддерживается.');
      const relative = ['/', '/chat', '/settings', '/history', '/brain'].includes(path) ? 'index.html' : decodeURIComponent(path).replace(/^\/+/, '');
      const file = resolve(publicDir, relative);
      if (!file.startsWith(publicDir + sep)) throw new AppError(403, 'Доступ запрещён.');
      if (!mime[extname(file)]) throw new AppError(404, 'Файл не найден.');
      let size: number;
      try { size = (await stat(file)).size; } catch { throw new AppError(404, 'Страница не найдена.'); }
      res.writeHead(200, { 'Content-Type': mime[extname(file)]!, 'Content-Length': size });
      res.end(req.method === 'HEAD' ? undefined : await readFile(file));
    } catch (error) {
      if (res.destroyed) return;
      const safe = publicError(error);
      if (res.headersSent) res.end(`data: ${JSON.stringify({ error: safe.error })}\n\n`);
      else json(res, safe.status, { error: safe.error });
    }
  }
  return server;
}
function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}
async function body(req: IncomingMessage): Promise<unknown> {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new AppError(415, 'Требуется JSON.');
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const part = Buffer.from(chunk as Uint8Array);
    size += part.length;
    if (size > 131072) throw new AppError(413, 'Запрос слишком большой.');
    chunks.push(part);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; }
  catch { throw new AppError(400, 'Не удалось прочитать JSON.'); }
}
export function validateMessages(input: unknown): ChatMessage[] {
  const raw = input && typeof input === 'object' ? (input as Record<string, unknown>).messages : undefined;
  if (!Array.isArray(raw) || !raw.length || raw.length > 24) throw new AppError(400, 'В запросе допустимы от 1 до 24 сообщений.');
  let total = 0;
  const messages = raw.map((item: unknown) => {
    if (!item || typeof item !== 'object') throw new AppError(400, 'Некорректное сообщение.');
    const message = item as Record<string, unknown>;
    if ((message.role !== 'user' && message.role !== 'assistant') || typeof message.content !== 'string' || !message.content.trim()) {
      throw new AppError(400, 'Некорректная роль или пустое сообщение.');
    }
    total += message.content.length;
    if (total > 60000) throw new AppError(400, 'Контекст превысил 60 000 символов. Начните новый разговор.');
    return { role: message.role, content: message.content } as ChatMessage;
  });
  if (messages.at(-1)?.role !== 'user') throw new AppError(400, 'Последним должно быть сообщение пользователя.');
  return messages;
}

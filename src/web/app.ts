import type { ChatMessage, PublicSettings } from '../shared/types.js';
import { sseData } from '../shared/sse.js';

function element<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element: ${id}`);
  return node as T;
}
const input = element<HTMLTextAreaElement>('prompt');
const messages = element<HTMLDivElement>('messages');
const key = element<HTMLInputElement>('api-key');
const model = element<HTMLInputElement>('model');
const maxTokens = element<HTMLInputElement>('max-tokens');
const send = element<HTMLButtonElement>('send');
const stop = element<HTMLButtonElement>('stop');
const history: ChatMessage[] = [];
let currentSettings: PublicSettings | undefined;
let controller: AbortController | undefined;
let noticeTimer: ReturnType<typeof setTimeout>;

function notice(message: string, error = false) {
  const node = element('notice');
  clearTimeout(noticeTimer);
  node.textContent = message;
  node.classList.toggle('error', error);
  node.hidden = false;
  noticeTimer = setTimeout(() => { node.hidden = true; }, error ? 15000 : 6000);
}
async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, headers: { 'Content-Type': 'application/json', ...init?.headers } });
  const data = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(data.error ?? `Ошибка HTTP ${response.status}`);
  return data;
}
function errorMessage(error: unknown) { return error instanceof Error ? error.message : 'Не удалось выполнить действие.'; }
function applySettings(value: PublicSettings) {
  currentSettings = value;
  model.value = value.model;
  maxTokens.value = String(value.maxTokens);
  key.value = '';
  element('key-status').textContent = value.keyConfigured ? 'Ключ сохранён. Оставь поле пустым, чтобы сохранить его.' : 'Ключ ещё не сохранён.';
  element('model-label').textContent = value.model || 'Выбери модель в настройках';
  element('connection-status').textContent = value.keyConfigured && value.model ? 'Cloud.ru настроен' : 'Нужна настройка';
  element('connection-status').classList.toggle('configured', value.keyConfigured && Boolean(value.model));
}
function navigate() {
  const settings = location.pathname === '/settings';
  element('chat-page').hidden = settings;
  element('settings-page').hidden = !settings;
  document.querySelectorAll<HTMLElement>('[data-nav]').forEach(node => {
    const active = node.dataset.nav === (settings ? 'settings' : 'chat');
    node.classList.toggle('active', active);
    if (active) node.setAttribute('aria-current', 'page'); else node.removeAttribute('aria-current');
  });
}
document.addEventListener('click', event => {
  if (!(event.target instanceof Element)) return;
  const link = event.target.closest<HTMLAnchorElement>('a[href]');
  if (!link || link.origin !== location.origin || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
  if (!['/chat', '/settings'].includes(link.pathname)) return;
  event.preventDefault();
  window.history.pushState({}, '', link.pathname);
  navigate();
});
window.addEventListener('popstate', navigate);
navigate();
void api<PublicSettings>('/api/settings').then(applySettings).catch(error => notice(errorMessage(error), true));

element('settings-form').addEventListener('submit', event => {
  event.preventDefault();
  void runButton(event.submitter as HTMLButtonElement, async () => {
    applySettings(await api<PublicSettings>('/api/settings', { method: 'PUT', body: JSON.stringify({ model: model.value, maxTokens: Number(maxTokens.value), apiKey: key.value.trim() }) }));
    notice('Настройки сохранены.');
  });
});
element('clear-key').addEventListener('click', event => {
  void runButton(event.currentTarget as HTMLButtonElement, async () => {
    applySettings(await api<PublicSettings>('/api/settings', { method: 'PUT', body: JSON.stringify({ model: model.value, maxTokens: Number(maxTokens.value), clearApiKey: true }) }));
    notice('Ключ удалён с диска.');
  });
});
element('load-models').addEventListener('click', event => {
  void runButton(event.currentTarget as HTMLButtonElement, async () => {
    const data = await api<{ models: string[] }>('/api/models');
    const list = element<HTMLDataListElement>('models');
    list.replaceChildren(...data.models.map(id => { const option = document.createElement('option'); option.value = id; return option; }));
    model.focus();
    notice(`Загружено моделей: ${data.models.length}. Выбери модель и сохрани настройки.`);
  });
});
element('check-connection').addEventListener('click', event => {
  void runButton(event.currentTarget as HTMLButtonElement, async () => {
    if (model.value.trim() !== currentSettings?.model || key.value || Number(maxTokens.value) !== currentSettings.maxTokens) {
      throw new Error('Сначала сохрани изменения, затем проверь модель.');
    }
    notice('Проверяю сохранённую модель…');
    const data = await api<{ message: string }>('/api/connection', { method: 'POST', body: '{}' });
    notice(data.message);
  });
});
async function runButton(button: HTMLButtonElement | null, action: () => Promise<void>) {
  if (button?.disabled) return;
  if (button) button.disabled = true;
  try { await action(); }
  catch (error) { notice(errorMessage(error), true); }
  finally { if (button) button.disabled = false; }
}
function appendMessage(role: ChatMessage['role'], text: string): HTMLParagraphElement {
  element('welcome').hidden = true;
  messages.hidden = false;
  const article = document.createElement('article');
  article.className = `message ${role}`;
  const label = document.createElement('span');
  label.className = 'message-role';
  label.textContent = role === 'user' ? 'Ты' : 'Кагэмиюра';
  const paragraph = document.createElement('p');
  paragraph.textContent = text;
  article.append(label, paragraph);
  messages.append(article);
  messages.scrollTop = messages.scrollHeight;
  return paragraph;
}
element('chat-form').addEventListener('submit', event => { event.preventDefault(); void submit(); });
input.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    void submit();
  }
});
stop.addEventListener('click', () => controller?.abort());
element('new-chat').addEventListener('click', () => {
  if (controller) { notice('Сначала останови текущий ответ.'); return; }
  if (history.length && !confirm('Очистить текущий разговор? Переписка не сохраняется на диске.')) return;
  history.length = 0;
  messages.replaceChildren();
  messages.hidden = true;
  element('welcome').hidden = false;
  window.history.pushState({}, '', '/chat');
  navigate();
  input.focus();
});
async function submit() {
  const text = input.value.trim();
  if (!text || controller) return;
  if (!currentSettings?.keyConfigured || !currentSettings.model) { notice('Сначала сохрани ключ и модель в настройках.', true); return; }
  const pending: ChatMessage = { role: 'user', content: text };
  const context = [...history, pending].slice(-23);
  if (context.reduce((sum, message) => sum + message.content.length, 0) > 60000) { notice('Разговор стал слишком большим. Начни новый разговор.', true); return; }
  history.push(pending);
  appendMessage('user', text);
  input.value = '';
  const reply = appendMessage('assistant', 'Думаю…');
  reply.classList.add('thinking');
  let answer = '';
  let done = false;
  const request = new AbortController();
  controller = request;
  send.disabled = true;
  stop.hidden = false;
  try {
    const response = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: context }), signal: request.signal });
    if (!response.ok) {
      const data = await response.json() as { error?: string };
      throw new Error(data.error ?? 'Не удалось отправить сообщение.');
    }
    if (!response.body) throw new Error('Не удалось открыть поток ответа.');
    for await (const frame of sseData(response.body)) {
      const part = JSON.parse(frame) as { text?: string; done?: boolean; error?: string };
      if (part.error) throw new Error(part.error);
      if (part.text) {
        answer += part.text;
        reply.textContent = answer;
        reply.classList.remove('thinking');
        messages.scrollTop = messages.scrollHeight;
      }
      if (part.done) done = true;
    }
    if (!done) throw new Error('Соединение прервалось. Полученная часть ответа оставлена в чате.');
    if (!answer) throw new Error('Модель вернула пустой ответ. Попробуй другую модель.');
  } catch (error) {
    const message = request.signal.aborted ? 'Ответ остановлен.' : errorMessage(error);
    if (!answer) reply.textContent = message;
    else notice(message, !request.signal.aborted);
    reply.classList.remove('thinking');
    reply.classList.add('interrupted');
    if (!request.signal.aborted && !answer) notice(message, true);
  } finally {
    if (answer) history.push({ role: 'assistant', content: answer });
    else { history.pop(); input.value = text; }
    controller = undefined;
    send.disabled = false;
    stop.hidden = true;
    input.focus();
  }
}

import type { ChatMessage, Conversation, ConversationSummary, PublicSettings } from '../shared/types.js';
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
let conversation: Conversation | undefined;
let ready = false;
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
  const page = location.pathname === '/settings' ? 'settings' : location.pathname === '/history' ? 'history' : 'chat';
  for (const name of ['chat', 'settings', 'history']) element(`${name}-page`).hidden = page !== name;
  if (page === 'history') void loadHistory();
  document.querySelectorAll<HTMLElement>('[data-nav]').forEach(node => {
    const active = node.dataset.nav === page;
    node.classList.toggle('active', active);
    if (active) node.setAttribute('aria-current', 'page'); else node.removeAttribute('aria-current');
  });
}
document.addEventListener('click', event => {
  if (!(event.target instanceof Element)) return;
  const link = event.target.closest<HTMLAnchorElement>('a[href]');
  if (!link || link.origin !== location.origin || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
  if (!['/chat', '/settings', '/history'].includes(link.pathname)) return;
  event.preventDefault();
  window.history.pushState({}, '', link.pathname);
  navigate();
});
window.addEventListener('popstate', navigate);
navigate();
void initialize();

async function initialize() {
  send.disabled = true;
  try {
    applySettings(await api<PublicSettings>('/api/settings'));
    let id: string | null = null;
    try { id = localStorage.getItem('kagemiyura-conversation'); } catch { /* disk history works without browser storage */ }
    if (id && /^[a-f0-9-]{36}$/.test(id)) {
      const response = await fetch(`/api/conversations/${id}`);
      if (response.ok) showConversation(await response.json() as Conversation);
      else if (response.status === 404) showConversation(undefined);
      else throw new Error('Не удалось восстановить разговор. Обновите страницу.');
    }
    ready = true;
  } catch (error) { notice(errorMessage(error), true); }
  finally { send.disabled = !ready; }
}

function showConversation(value: Conversation | undefined) {
  conversation = value;
  try {
    if (value) localStorage.setItem('kagemiyura-conversation', value.id);
    else localStorage.removeItem('kagemiyura-conversation');
  } catch { /* browser storage can be disabled */ }
  messages.replaceChildren();
  messages.hidden = !value?.messages.length;
  element('welcome').hidden = Boolean(value?.messages.length);
  element('conversation-title').textContent = value?.title ?? 'Новый разговор';
  element('conversation-tools').hidden = !value;
  for (const message of value?.messages ?? []) {
    const paragraph = appendMessage(message.role, message.content || (message.status === 'pending' ? 'Ответ формируется в другой вкладке…' : 'Ответ не получен.'));
    if (message.status !== 'complete') {
      paragraph.classList.add('interrupted');
      const status = document.createElement('small');
      status.className = 'message-status';
      status.textContent = message.status === 'pending' ? 'В процессе' : message.status === 'error' ? 'Ошибка ответа' : 'Ответ прерван';
      paragraph.after(status);
    }
  }
}

async function openConversation(id: string) {
  if (controller) throw new Error('Сначала останови текущий ответ.');
  const value = await api<Conversation>(`/api/conversations/${id}`);
  if (controller) return;
  showConversation(value);
  window.history.pushState({}, '', '/chat');
  navigate();
}

let historyRequest = 0;
let historyOffset = 0;
let historyTimer: ReturnType<typeof setTimeout>;
async function loadHistory(more = false) {
  const request = ++historyRequest;
  const offset = more ? historyOffset : 0;
  const query = element<HTMLInputElement>('history-search').value.trim();
  try {
    const result = await api<{ conversations: ConversationSummary[]; hasMore: boolean }>(`/api/conversations?q=${encodeURIComponent(query)}&offset=${offset}`);
    if (request !== historyRequest) return;
    const list = element('history-list');
    if (!more) list.replaceChildren();
    for (const item of result.conversations) {
      const button = document.createElement('button');
      button.className = 'conversation-row';
      const title = document.createElement('span');
      title.textContent = item.title;
      const meta = document.createElement('small');
      meta.textContent = `${new Date(item.updatedAt).toLocaleString('ru-RU')} · Сообщений: ${item.messageCount}`;
      button.append(title, meta);
      button.addEventListener('click', () => { void runButton(button, () => openConversation(item.id)); });
      list.append(button);
    }
    historyOffset = offset + result.conversations.length;
    element('history-empty').hidden = list.childElementCount > 0;
    element('history-more').hidden = !result.hasMore;
  } catch (error) { if (request === historyRequest) notice(errorMessage(error), true); }
}
element('history-search').addEventListener('input', () => {
  ++historyRequest;
  clearTimeout(historyTimer);
  historyTimer = setTimeout(() => { void loadHistory(); }, 250);
});
element('history-more').addEventListener('click', event => { void runButton(event.currentTarget as HTMLButtonElement, () => loadHistory(true)); });
element('history-refresh').addEventListener('click', event => { void runButton(event.currentTarget as HTMLButtonElement, () => loadHistory()); });
element('rename-chat').addEventListener('click', event => {
  void runButton(event.currentTarget as HTMLButtonElement, async () => {
    if (!conversation || controller) return;
    const title = prompt('Название разговора', conversation.title);
    if (title === null) return;
    showConversation(await api<Conversation>(`/api/conversations/${conversation.id}`, { method: 'PATCH', body: JSON.stringify({ title }) }));
  });
});
element('delete-chat').addEventListener('click', event => {
  void runButton(event.currentTarget as HTMLButtonElement, async () => {
    if (!conversation || controller) return;
    if (!confirm(`Удалить разговор «${conversation.title}» с диска?`)) return;
    await api(`/api/conversations/${conversation.id}`, { method: 'DELETE' });
    showConversation(undefined);
    notice('Разговор удалён.');
  });
});
element('export-chat').addEventListener('click', event => {
  void runButton(event.currentTarget as HTMLButtonElement, async () => {
    if (!conversation) return;
    const value = await api<Conversation>(`/api/conversations/${conversation.id}`);
    const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `Kagemiyura-${value.id}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
});

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
  showConversation(undefined);
  input.value = '';
  window.history.pushState({}, '', '/chat');
  navigate();
  input.focus();
});
async function submit() {
  const text = input.value.trim();
  if (!text || controller || !ready) return;
  if (!currentSettings?.keyConfigured || !currentSettings.model) { notice('Сначала сохрани ключ и модель в настройках.', true); return; }
  let answer = '';
  let done = false;
  let reply: HTMLParagraphElement | undefined;
  const request = new AbortController();
  controller = request;
  send.disabled = true;
  stop.hidden = false;
  try {
    if (!conversation) showConversation(await api<Conversation>('/api/conversations', { method: 'POST', body: '{}' }));
    if (request.signal.aborted) return;
    appendMessage('user', text);
    input.value = '';
    reply = appendMessage('assistant', 'Думаю…');
    reply.classList.add('thinking');
    const response = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ conversationId: conversation!.id, content: text }), signal: request.signal });
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
    if (!answer && reply) reply.textContent = message;
    else notice(message, !request.signal.aborted);
    reply?.classList.remove('thinking');
    reply?.classList.add('interrupted');
    if (!request.signal.aborted && !answer) notice(message, true);
  } finally {
    if (!answer) input.value = text;
    if (conversation) {
      try {
        const saved = await api<Conversation>(`/api/conversations/${conversation.id}`);
        if (!saved.messages.some(message => message.status === 'pending')) showConversation(saved);
      } catch { notice('Не удалось перечитать историю. Обнови страницу перед следующим сообщением.', true); }
    }
    controller = undefined;
    send.disabled = false;
    stop.hidden = true;
    input.focus();
  }
}

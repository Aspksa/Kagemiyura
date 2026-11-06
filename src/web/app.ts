import type { ChatMessage, Conversation, ConversationSummary, PublicSettings } from '../shared/types.js';
import { sseData } from '../shared/sse.js';
import { createBrain } from './brain.js';

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
const brain = createBrain(id => openConversation(id));

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
  const chatOpen = location.pathname === '/chat';
  const background = chatOpen ? returnPage : location.pathname;
  const page = background === '/settings' ? 'settings' : background === '/history' ? 'history' : background === '/brain' ? 'brain' : 'home';
  for (const name of ['settings', 'history', 'brain', 'home']) element(`${name}-page`).hidden = page !== name;
  document.body.classList.toggle('on-home', page === 'home');
  document.body.classList.toggle('on-brain', page === 'brain');
  brain.setVisible(page === 'brain');
  element('chat-page').hidden = !chatOpen;
  const avatar = element<HTMLButtonElement>('avatar');
  avatar.setAttribute('aria-expanded', String(chatOpen));
  avatar.setAttribute('aria-label', chatOpen ? 'Закрыть чат с Кагэмиюрой' : 'Открыть чат с Кагэмиюрой');
  if (page === 'history') void loadHistory();
  document.querySelectorAll<HTMLElement>('[data-nav]').forEach(node => {
    const active = node.dataset.nav === page;
    node.classList.toggle('active', active);
    if (active) node.setAttribute('aria-current', 'page'); else node.removeAttribute('aria-current');
  });
}
let returnPage = '/';
function closeChat() {
  window.history.pushState({}, '', returnPage);
  navigate();
  element<HTMLButtonElement>('avatar').focus();
}
element('avatar').addEventListener('click', () => {
  if (location.pathname === '/chat') { closeChat(); return; }
  returnPage = ['/settings', '/history', '/brain'].includes(location.pathname) ? location.pathname : '/';
  window.history.pushState({}, '', '/chat');
  navigate();
  input.focus();
});
element('close-chat').addEventListener('click', closeChat);
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !element<HTMLDialogElement>('avatar-settings').open && location.pathname === '/chat') closeChat();
});
document.addEventListener('click', event => {
  if (!(event.target instanceof Element)) return;
  const link = event.target.closest<HTMLAnchorElement>('a[href]');
  if (!link || link.origin !== location.origin || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
  if (!['/', '/chat', '/settings', '/history', '/brain'].includes(link.pathname)) return;
  event.preventDefault();
  window.history.pushState({}, '', link.pathname);
  navigate();
});
window.addEventListener('popstate', navigate);


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
  if (!ready) throw new Error('Дождись загрузки страницы.');
  if (controller) throw new Error('Сначала останови текущий ответ.');
  const value = await api<Conversation>(`/api/conversations/${id}`);
  if (controller) return;
  showConversation(value);
  if (location.pathname !== '/chat') returnPage = location.pathname;
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
    const id = conversation.id;
    const saved = await api<Conversation>(`/api/conversations/${id}`, { method: 'PATCH', body: JSON.stringify({ title }) });
    if (conversation?.id === id) showConversation(saved);
  });
});
element('delete-chat').addEventListener('click', event => {
  void runButton(event.currentTarget as HTMLButtonElement, async () => {
    if (!conversation || controller) return;
    if (!confirm(`Удалить разговор «${conversation.title}» с диска?`)) return;
    const id = conversation.id;
    await api(`/api/conversations/${id}`, { method: 'DELETE' });
    if (conversation?.id === id) showConversation(undefined);
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
  if (!ready) return;
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

navigate();
void initialize();

// Настройки относятся только к оформлению в этом браузере и не меняют ответы модели.
type AvatarValues = {
  size: number; brightness: number; contrast: number; saturation: number; hue: number; opacity: number;
  glow: number; color: string; circle: boolean; circleSize: number; circleSpeed: number; shadow: number;
  particles: string; particleCount: number; fire: boolean; fireStrength: number; motion: string; motionSpeed: number;
  warmth: number; sharpness: number; halo: boolean; haloStrength: number; circleOpacity: number; particleSize: number; particleSpeed: number; particleOpacity: number;
};
const avatarDefaults: AvatarValues = { size: 140, brightness: 100, contrast: 100, saturation: 100, hue: 0, opacity: 100, glow: 45, color: '#e9b968', circle: false, circleSize: 105, circleSpeed: 20, shadow: 50, particles: 'none', particleCount: 8, fire: false, fireStrength: 45, motion: 'still', motionSpeed: 5, warmth: 0, sharpness: 0, halo: false, haloStrength: 45, circleOpacity: 75, particleSize: 100, particleSpeed: 100, particleOpacity: 85 };
type AvatarKey = keyof AvatarValues;
type AvatarControl = { key: AvatarKey; label: string; kind: 'range' | 'color' | 'check' | 'select'; min?: number; max?: number; step?: number; unit?: string; options?: [string, string][]; hint?: string };
const avatarGroups: { title: string; description: string; controls: AvatarControl[] }[] = [
  { title: 'Образ', description: 'Размер и цвет изображения.', controls: [
    {key:'size',label:'Размер',kind:'range',min:70,max:260,unit:'пкс'}, {key:'opacity',label:'Непрозрачность',kind:'range',min:20,max:100,unit:'%'},
    {key:'brightness',label:'Яркость',kind:'range',min:40,max:160,unit:'%'}, {key:'contrast',label:'Контраст',kind:'range',min:40,max:160,unit:'%'},
    {key:'saturation',label:'Насыщенность',kind:'range',min:0,max:200,unit:'%'}, {key:'hue',label:'Оттенок',kind:'range',min:-180,max:180,unit:'°'},
    {key:'warmth',label:'Тёплый тон',kind:'range',min:0,max:100,unit:'%'}, {key:'sharpness',label:'Мягкость',kind:'range',min:0,max:30,unit:'%',hint:'Добавляет мягкое размытие.'} ] },
  { title: 'Магия', description: 'Сияние, круг и тень у ног.', controls: [
    {key:'color',label:'Цвет магии',kind:'color'}, {key:'glow',label:'Сияние',kind:'range',min:0,max:100,unit:'%'},
    {key:'circle',label:'Магический круг',kind:'check'}, {key:'circleSize',label:'Размер круга',kind:'range',min:60,max:150,unit:'%'},
    {key:'circleSpeed',label:'Оборот круга',kind:'range',min:4,max:60,unit:'сек',hint:'Меньше секунд — быстрее вращение.'}, {key:'circleOpacity',label:'Яркость круга',kind:'range',min:0,max:100,unit:'%'},
    {key:'halo',label:'Магическая аура',kind:'check'}, {key:'haloStrength',label:'Сила ауры',kind:'range',min:0,max:100,unit:'%'},
    {key:'shadow',label:'Тень у ног',kind:'range',min:0,max:100,unit:'%'} ] },
  { title: 'Частицы', description: 'Небольшие эффекты вокруг аватара.', controls: [
    {key:'particles',label:'Вид частиц',kind:'select',options:[['none','Нет'],['sparks','Золотые искры'],['sakura','Сакура'],['fireflies','Светлячки'],['stars','Звёздная пыль'],['embers','Тлеющие угольки']]},
    {key:'particleCount',label:'Количество',kind:'range',min:2,max:30,unit:'шт.'}, {key:'particleSize',label:'Размер частиц',kind:'range',min:40,max:200,unit:'%'},
    {key:'particleSpeed',label:'Скорость частиц',kind:'range',min:50,max:200,unit:'%'}, {key:'particleOpacity',label:'Яркость частиц',kind:'range',min:10,max:100,unit:'%'},
    {key:'fire',label:'Огонь у хвостов',kind:'check',hint:'Декоративное пламя за нижней частью изображения.'}, {key:'fireStrength',label:'Сила огня',kind:'range',min:0,max:100,unit:'%'} ] },
  { title: 'Движение и характер', description: 'Настроение влияет на движение изображения, а не на характер ответов ИИ.', controls: [
    {key:'motion',label:'Настроение движения',kind:'select',options:[['still','Без движения'],['gentle','Нежная'],['lively','Оживлённая'],['mystic','Таинственная']]},
    {key:'motionSpeed',label:'Длительность движения',kind:'range',min:2,max:12,unit:'сек'} ] },
  { title: 'Инструменты', description: 'Настройки хранятся только в этом браузере и не отправляются в Cloud.ru.', controls: [] },
];
const avatarButton = element<HTMLButtonElement>('avatar');
const avatarDialog = element<HTMLDialogElement>('avatar-settings');
let avatarValues: AvatarValues = {...avatarDefaults};
try {
  const saved = JSON.parse(localStorage.getItem('kagemiyura-avatar-v1') ?? '{}') as Record<string, unknown>;
  for (const group of avatarGroups) for (const control of group.controls) {
    const v = saved[control.key];
    if (control.kind === 'range' && typeof v === 'number' && Number.isFinite(v)) (avatarValues[control.key] as number) = Math.min(control.max!, Math.max(control.min!, v));
    else if (control.kind === 'check' && typeof v === 'boolean') (avatarValues[control.key] as boolean) = v;
    else if (control.kind === 'color' && typeof v === 'string' && /^#[\da-f]{6}$/i.test(v)) (avatarValues[control.key] as string) = v;
    else if (control.kind === 'select' && typeof v === 'string' && control.options?.some(option => option[0] === v)) (avatarValues[control.key] as string) = v;
  }
} catch { /* settings are optional when storage is unavailable */ }
let activeAvatarTab = 0;
function applyAvatar() {
  const v = avatarValues;
  const style = avatarButton.style;
  document.documentElement.style.setProperty('--avatar-size', `${v.size}px`);
  style.setProperty('--avatar-size', `${v.size}px`); style.setProperty('--avatar-brightness', `${v.brightness}%`);
  style.setProperty('--avatar-contrast', `${v.contrast}%`); style.setProperty('--avatar-saturation', `${v.saturation}%`);
  style.setProperty('--avatar-hue', `${v.hue}deg`); style.setProperty('--avatar-opacity', String(v.opacity / 100));
  style.setProperty('--avatar-warmth', `${v.warmth}%`); style.setProperty('--avatar-softness', `${v.sharpness / 20}px`);
  style.setProperty('--magic-color', v.color); style.setProperty('--glow', `${v.glow / 5}px`);
  style.setProperty('--circle-size', `${v.circleSize}%`); style.setProperty('--circle-duration', `${v.circleSpeed}s`);
  style.setProperty('--shadow-opacity', String(v.shadow / 100)); style.setProperty('--fire-opacity', String(v.fire ? v.fireStrength / 100 : 0));
  style.setProperty('--motion-duration', `${v.motionSpeed}s`);
  style.setProperty('--circle-opacity', String(v.circleOpacity / 100)); style.setProperty('--halo-opacity', String(v.halo ? v.haloStrength / 100 : 0));
  style.setProperty('--particle-scale', String(v.particleSize / 100)); style.setProperty('--particle-opacity', String(v.particleOpacity / 100));
  avatarButton.dataset.circle = String(v.circle); avatarButton.dataset.motion = v.motion; avatarButton.dataset.particles = v.particles;
  const container = avatarButton.querySelector<HTMLElement>('.avatar-particles')!;
  container.replaceChildren();
  if (v.particles !== 'none') for (let i = 0; i < v.particleCount; i++) {
    const spark = document.createElement('span'); spark.className = 'avatar-particle';
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox','0 0 24 24'); svg.setAttribute('aria-hidden','true');
    const path = document.createElementNS('http://www.w3.org/2000/svg','path');
    const shape = v.particles === 'sakura' ? 'M12 21C9 17 3 15 4 9C5 3 10 2 12 7C14 2 19 3 20 9C21 15 15 18 12 21Z' : v.particles === 'fireflies' ? 'M12 3C14 7 15 8 15 11C15 14 14 17 12 20C10 17 9 14 9 11C9 8 10 7 12 3Z' : v.particles === 'embers' ? 'M12 2C14 7 19 9 18 15C18 20 15 22 12 22C8 22 5 19 6 15C7 11 10 8 12 2Z' : 'M12 1L14 9L22 12L14 14L12 23L10 14L2 12L10 9Z';
    path.setAttribute('d',shape); svg.append(path);
    const detail = document.createElementNS('http://www.w3.org/2000/svg','path');
    detail.setAttribute('d', v.particles === 'sakura' ? 'M12 20C12 15 9 11 7 8M12 16C14 12 16 10 18 8' : v.particles === 'fireflies' ? 'M10 10C5 5 2 8 7 12M14 10C19 5 22 8 17 12M10 15H14' : v.particles === 'embers' ? 'M12 19C9 17 10 14 12 11C13 14 15 15 14 18' : 'M12 5V19M5 12H19');
    detail.setAttribute('fill','none'); detail.setAttribute('stroke','#fff'); detail.setAttribute('stroke-width','1'); detail.setAttribute('stroke-linecap','round'); svg.append(detail); spark.append(svg);
    spark.style.left = `${5 + (i * 37 % 90)}%`;
    spark.style.setProperty('--spark-drift', `${(i * 29 % 65) - 32}px`);
    spark.style.setProperty('--spark-sway', `${(i * 17 % 45) - 22}px`);
    spark.style.setProperty('--spark-rotate', `${(i * 47 % 180) - 90}deg`);
    spark.style.setProperty('--spark-depth', String(0.55 + (i * 13 % 46) / 100));
    spark.style.animationDelay = `${-(i * 0.61)}s`;
    spark.style.animationDuration = `${(3 + (i % 4)) * 100 / v.particleSpeed}s`; container.append(spark);
  }
  const preview = avatarButton.cloneNode(true) as HTMLButtonElement; preview.removeAttribute('id'); preview.tabIndex = -1; preview.classList.add('avatar-preview-copy');
  element('avatar-preview-art').replaceChildren(preview);
  try { localStorage.setItem('kagemiyura-avatar-v1', JSON.stringify(v)); } catch { /* browser may block storage */ }
}
function renderAvatarSettings() {
  const tabs = element('avatar-tabs'); const controls = element('avatar-controls'); tabs.replaceChildren(); controls.replaceChildren();
  avatarGroups.forEach((group, index) => {
    const tab = document.createElement('button'); tab.type = 'button'; tab.textContent = group.title;
    tab.className = index === activeAvatarTab ? 'selected' : ''; tab.setAttribute('aria-pressed', String(index === activeAvatarTab));
    tab.addEventListener('click', () => { activeAvatarTab = index; renderAvatarSettings(); }); tabs.append(tab);
  });
  const group = avatarGroups[activeAvatarTab]!;
  const heading = document.createElement('h3'); heading.textContent = group.title;
  const description = document.createElement('p'); description.className = 'avatar-description'; description.textContent = group.description;
  controls.append(heading, description);
  if (activeAvatarTab === 0) {
    const presets = document.createElement('div'); presets.className = 'avatar-presets';
    const choices = [
      {title:'Оригинал', values:{brightness:100, contrast:100, saturation:100, hue:0, warmth:0, sharpness:0}},
      {title:'Тёплый', values:{brightness:105, contrast:102, saturation:115, hue:0, warmth:20, sharpness:0}},
      {title:'Лунный', values:{brightness:108, contrast:95, saturation:72, hue:18, warmth:0, sharpness:4}},
    ];
    for (const preset of choices) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = preset.title;
      button.addEventListener('click', () => { Object.assign(avatarValues, preset.values); applyAvatar(); renderAvatarSettings(); }); presets.append(button);
    }
    controls.append(presets);
  }
  for (const config of group.controls) {
    const row = document.createElement('label'); row.className = 'avatar-control';
    const title = document.createElement('span'); title.className = 'avatar-control-title'; title.textContent = config.label;
    const value = document.createElement('output'); const field = document.createElement(config.kind === 'select' ? 'select' : 'input');
    field.setAttribute('aria-label', config.label);
    if (field instanceof HTMLInputElement) {
      field.type = config.kind === 'check' ? 'checkbox' : config.kind;
      if (config.kind === 'range') { field.min = String(config.min); field.max = String(config.max); field.step = String(config.step ?? 1); }
      if (config.kind === 'check') field.checked = Boolean(avatarValues[config.key]); else field.value = String(avatarValues[config.key]);
    } else if (field instanceof HTMLSelectElement) {
      for (const [id, label] of config.options ?? []) { const option = document.createElement('option'); option.value = id; option.textContent = label; field.append(option); }
      field.value = String(avatarValues[config.key]);
    }
    function setOutput() { value.textContent = config.kind === 'range' ? `${String(avatarValues[config.key])} ${config.unit ?? ''}` : ''; }
    setOutput();
    field.addEventListener('input', () => {
      const next = field instanceof HTMLInputElement && config.kind === 'check' ? field.checked : config.kind === 'range' ? Number(field.value) : field.value;
      Object.assign(avatarValues, {[config.key]: next}); setOutput(); applyAvatar();
    });
    row.append(title, value, field);
    if (config.hint) { const hint = document.createElement('small'); hint.textContent = config.hint; row.append(hint); }
    controls.append(row);
  }
  if (activeAvatarTab === avatarGroups.length - 1) {
    const reset = document.createElement('button'); reset.type = 'button'; reset.className = 'secondary avatar-reset'; reset.textContent = 'Вернуть исходный вид';
    reset.addEventListener('click', () => { avatarValues = {...avatarDefaults}; applyAvatar(); renderAvatarSettings(); }); controls.append(reset);
  }
}
function openAvatarSettings() { renderAvatarSettings(); if (!avatarDialog.open) avatarDialog.showModal(); }
avatarButton.addEventListener('contextmenu', event => { event.preventDefault(); openAvatarSettings(); });
element('avatar-settings-close').addEventListener('click', () => avatarDialog.close());
avatarDialog.addEventListener('click', event => { if (event.target === avatarDialog) avatarDialog.close(); });
let holdTimer: ReturnType<typeof setTimeout> | undefined;
let held = false;
avatarButton.addEventListener('pointerdown', event => {
  if (event.pointerType !== 'touch') return;
  held = false; holdTimer = setTimeout(() => { held = true; openAvatarSettings(); }, 550);
});
for (const name of ['pointerup', 'pointercancel', 'pointerleave']) avatarButton.addEventListener(name, () => { clearTimeout(holdTimer); });
avatarButton.addEventListener('click', event => { if (held) { event.preventDefault(); event.stopImmediatePropagation(); held = false; } }, true);
applyAvatar();

import type { ChatMessage } from '../shared/types.js';
import type { Settings } from './settings.js';
import { AppError } from './errors.js';
import { sseData } from '../shared/sse.js';

const endpoint = 'https://foundation-models.api.cloud.ru/v1';
const system = 'Ты Кагэмиюра, взрослая девятихвостая кицунэ и личная ИИ-помощница. Отвечай по-русски, тепло и по делу. Обращайся к пользователю «хозяин». Не выдумывай выполненные действия, доступ к файлам, память или возможности, которых у тебя нет.';
export class CloudClient {
  constructor(private readonly request: typeof fetch = fetch) {}
  private async call(path: string, settings: Settings, signal: AbortSignal, payload?: object): Promise<Response> {
    if (!settings.apiKey) throw new AppError(400, 'Сначала сохраните ключ Cloud.ru в настройках.');
    let response: Response;
    try {
      response = await this.request(`${endpoint}/${path}`, {
        method: payload ? 'POST' : 'GET',
        headers: { Authorization: `Bearer ${settings.apiKey}`, 'Content-Type': 'application/json' },
        ...(payload ? { body: JSON.stringify(payload) } : {}),
        signal: AbortSignal.any([signal, AbortSignal.timeout(120000)]), redirect: 'error',
      });
    } catch {
      throw new AppError(502, 'Cloud.ru не отвечает или запрос остановлен. Проверьте интернет и повторите вручную.');
    }
    if (!response.ok) {
      await response.body?.cancel();
      const messages: Record<number, string> = {
        401: 'Cloud.ru отклонил ключ. Проверьте ключ в настройках.',
        403: 'Cloud.ru запретил доступ. Проверьте разрешения ключа и доступ к модели.',
        404: 'Модель не найдена. Загрузите список моделей и проверьте выбор.',
        429: 'Достигнут лимит Cloud.ru. Подождите и повторите запрос вручную.',
      };
      throw new AppError(502, messages[response.status] ?? `Cloud.ru вернул ошибку HTTP ${response.status}. Запрос не повторялся.`);
    }
    return response;
  }
  async models(settings: Settings, signal: AbortSignal): Promise<string[]> {
    const response = await this.call('models', settings, signal);
    const payload = await response.json() as { data?: { id?: unknown }[] };
    if (!Array.isArray(payload.data)) throw new AppError(502, 'Cloud.ru вернул некорректный список моделей.');
    return [...new Set(payload.data.flatMap(item => typeof item.id === 'string' ? [item.id] : []))].sort();
  }
  async check(settings: Settings, signal: AbortSignal): Promise<void> {
    if (!settings.model) throw new AppError(400, 'Сначала выберите и сохраните модель.');
    const response = await this.call('chat/completions', settings, signal, {
      model: settings.model, messages: [{ role: 'user', content: 'Ответь: да' }], max_tokens: 1, stream: false,
    });
    const payload = await response.json() as { choices?: unknown[] };
    if (!Array.isArray(payload.choices) || !payload.choices.length) throw new AppError(502, 'Cloud.ru не вернул результат проверки.');
  }
  async *chat(settings: Settings, messages: ChatMessage[], signal: AbortSignal): AsyncGenerator<string> {
    if (!settings.model) throw new AppError(400, 'Выберите модель в настройках.');
    const response = await this.call('chat/completions', settings, signal, {
      model: settings.model, messages: [{ role: 'system', content: system }, ...messages], max_tokens: settings.maxTokens, stream: true,
    });
    if (!response.body) throw new AppError(502, 'Cloud.ru не вернул поток ответа.');
    let finished = false;
    try {
      for await (const frame of sseData(response.body)) {
        if (frame === '[DONE]') { finished = true; break; }
        const item = JSON.parse(frame) as { error?: unknown; choices?: { delta?: { content?: unknown }; finish_reason?: unknown }[] };
        if (item.error) throw new Error('Provider error');
        const choice = item.choices?.[0];
        if (typeof choice?.delta?.content === 'string') yield choice.delta.content;
        if (typeof choice?.finish_reason === 'string' && choice.finish_reason) finished = true;
      }
    } catch { throw new AppError(502, 'Поток ответа прервался. Полученная часть сохранена на экране.'); }
    if (!finished) throw new AppError(502, 'Ответ завершился неожиданно. Полученная часть сохранена на экране.');
  }
}

import { mkdir, readFile, rename, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { PublicSettings } from '../shared/types.js';
import { AppError } from './errors.js';

export interface Settings { model: string; maxTokens: number; apiKey: string }
const defaults: Settings = { model: '', maxTokens: 1024, apiKey: '' };
export class SettingsStore {
  readonly file: string;
  private pending: Promise<unknown> = Promise.resolve();
  constructor(readonly dataDir: string) { this.file = join(dataDir, 'cloudru-settings.json'); }
  async read(): Promise<Settings> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.file, 'utf8'));
      return validate(parsed, defaults);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ...defaults };
      throw new AppError(500, 'Файл настроек повреждён. Сохраните его копию перед исправлением: data/cloudru-settings.json.');
    }
  }
  async public(): Promise<PublicSettings> { return redact(await this.read()); }
  update(input: unknown): Promise<PublicSettings> {
    const task = this.pending.catch(() => {}).then(async () => {
      const value = validate(input, await this.read());
      await mkdir(this.dataDir, { recursive: true });
      const temp = `${this.file}.${randomUUID()}.tmp`;
      try {
        await writeFile(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
        await rename(temp, this.file);
      } finally { await rm(temp, { force: true }); }
      return redact(value);
    });
    this.pending = task;
    return task;
  }
}
export function redact(settings: Settings): PublicSettings {
  return { model: settings.model, maxTokens: settings.maxTokens, keyConfigured: Boolean(settings.apiKey) };
}
function validate(input: unknown, previous: Settings): Settings {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AppError(400, 'Некорректные настройки.');
  const value = input as Record<string, unknown>;
  if (typeof value.model !== 'string' || value.model.length > 200 || /[\r\n\0]/.test(value.model)) {
    throw new AppError(400, 'Укажите корректный идентификатор модели.');
  }
  if (!Number.isInteger(value.maxTokens) || Number(value.maxTokens) < 64 || Number(value.maxTokens) > 4096) {
    throw new AppError(400, 'Лимит ответа должен быть целым числом от 64 до 4096.');
  }
  if (value.apiKey !== undefined && (typeof value.apiKey !== 'string' || value.apiKey.length > 8192 || /\s/.test(value.apiKey))) {
    throw new AppError(400, 'В ключе не должно быть пробелов или переносов строк.');
  }
  if (value.clearApiKey !== undefined && typeof value.clearApiKey !== 'boolean') throw new AppError(400, 'Некорректное действие с ключом.');
  const key = value.clearApiKey === true ? '' : (typeof value.apiKey === 'string' && value.apiKey ? value.apiKey : previous.apiKey);
  return { model: value.model.trim(), maxTokens: Number(value.maxTokens), apiKey: key };
}

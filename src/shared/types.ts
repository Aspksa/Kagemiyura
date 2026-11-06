export interface ChatMessage { role: 'user' | 'assistant'; content: string }
export interface PublicSettings {
  model: string;
  maxTokens: number;
  keyConfigured: boolean;
}
export interface SettingsUpdate { model: string; maxTokens: number; apiKey?: string; clearApiKey?: boolean }
export interface Health {
  app: 'Kagemiyura'; version: string; instanceId: string; keyConfigured: boolean;
}

export interface ChatMessage { role: 'user' | 'assistant'; content: string }
export interface SavedMessage extends ChatMessage { status: 'complete' | 'pending' | 'interrupted' | 'error'; createdAt: string }
export interface ConversationSummary { id: string; title: string; createdAt: string; updatedAt: string; messageCount: number }
export interface Conversation { id: string; title: string; createdAt: string; updatedAt: string; messages: SavedMessage[] }
export interface PublicSettings {
  model: string;
  maxTokens: number;
  keyConfigured: boolean;
}
export interface SettingsUpdate { model: string; maxTokens: number; apiKey?: string; clearApiKey?: boolean }
export interface Health {
  app: 'Kagemiyura'; version: string; instanceId: string; keyConfigured: boolean;
}

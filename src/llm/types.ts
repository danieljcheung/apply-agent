export type ProviderKind = 'deepseek' | 'kimi' | 'openai-compatible' | 'local';

export interface LLMProviderConfig {
  id: string;
  name: string;
  kind: ProviderKind;
  model: string;
  baseUrl?: string;
  apiKey?: string;
  apiKeyRef?: string;
  isActive?: boolean;
}

export type LLMContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export type LLMMessageContent = string | LLMContentPart[];

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: LLMMessageContent;
}

export interface LLMRequestOptions {
  messages: LLMMessage[];
  temperature?: number;
  maxTokens?: number;
  responseFormat?: { type: 'json_object' };
}

export interface LLMUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface LLMResponse {
  content: string;
  usage?: LLMUsage;
}

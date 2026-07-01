import { redactLLMSecrets } from './redactor.js';
import type { LLMProviderConfig, LLMRequestOptions, LLMResponse, LLMUsage } from './types.js';

interface ChatCompletionPayload {
  model: string;
  messages: LLMRequestOptions['messages'];
  temperature?: number;
  response_format?: { type: 'json_object' };
  max_tokens?: number;
  max_completion_tokens?: number;
}

export class LLMProvider {
  readonly config: LLMProviderConfig;

  constructor(config: LLMProviderConfig) {
    this.config = config;
  }

  private getBaseUrl(): string {
    if (this.config.baseUrl) {
      return this.config.baseUrl;
    }
    switch (this.config.kind) {
      case 'deepseek':
        return 'https://api.deepseek.com/v1';
      case 'kimi':
        return 'https://api.moonshot.cn/v1';
      case 'local':
        return 'http://localhost:11434/v1';
      case 'openai-compatible':
      default:
        return 'https://api.openai.com/v1';
    }
  }

  private redact(text: string): string {
    const secrets = this.config.apiKey ? [this.config.apiKey] : [];
    return redactLLMSecrets(text, secrets);
  }

  private requiresMaxCompletionTokens(): boolean {
    if (
      this.config.kind === 'deepseek' ||
      this.config.kind === 'kimi' ||
      this.config.kind === 'local'
    ) {
      return false;
    }
    const model = this.config.model.toLowerCase();
    return model.startsWith('gpt-5') || /^o[0-9]/.test(model);
  }

  private supportsCustomTemperature(): boolean {
    return !this.requiresMaxCompletionTokens();
  }

  async execute(options: LLMRequestOptions): Promise<LLMResponse> {
    const baseUrl = this.getBaseUrl();
    let url = baseUrl;
    if (!url.endsWith('/chat/completions')) {
      url = url.endsWith('/') ? `${url}chat/completions` : `${url}/chat/completions`;
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (this.config.apiKey) {
      headers['Authorization'] = `Bearer ${this.config.apiKey}`;
    }

    const payload: ChatCompletionPayload = {
      model: this.config.model,
      messages: options.messages,
      ...(options.responseFormat ? { response_format: options.responseFormat } : {})
    };

    if (options.temperature !== undefined) {
      if (this.supportsCustomTemperature() || options.temperature === 1) {
        payload.temperature = options.temperature;
      }
    } else if (this.supportsCustomTemperature()) {
      payload.temperature = 0.7;
    }

    if (options.maxTokens !== undefined) {
      if (this.requiresMaxCompletionTokens()) {
        payload.max_completion_tokens = options.maxTokens;
      } else {
        payload.max_tokens = options.maxTokens;
      }
    }

    let retriedMaxTokens = false;
    let retriedTemperature = false;
    while (true) {
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload)
        });

        if (!response.ok) {
          let errorText = '';
          try {
            errorText = await response.text();
          } catch {
            errorText = response.statusText;
          }

          let parsedError: unknown = null;
          try {
            parsedError = JSON.parse(errorText);
          } catch {}
          const errorRecord = parsedError && typeof parsedError === 'object'
            ? parsedError as { error?: { code?: unknown; param?: unknown; message?: unknown } }
            : {};
          const errorCode = String(errorRecord.error?.code ?? '');
          const errorParam = String(errorRecord.error?.param ?? '');
          const errorMessage = String(errorRecord.error?.message ?? errorText);

          const isUnsupportedMaxTokens =
            errorCode === 'unsupported_parameter' &&
            (errorParam === 'max_tokens' ||
              (errorMessage.includes('max_tokens') && errorMessage.includes('max_completion_tokens')));

          if (!retriedMaxTokens && payload.max_tokens !== undefined && isUnsupportedMaxTokens) {
            payload.max_completion_tokens = payload.max_tokens;
            delete payload.max_tokens;
            retriedMaxTokens = true;
            continue;
          }

          const isUnsupportedTemperature =
            (errorCode === 'unsupported_value' || errorCode === 'unsupported_parameter') &&
            errorParam === 'temperature';

          if (!retriedTemperature && payload.temperature !== undefined && isUnsupportedTemperature) {
            delete payload.temperature;
            retriedTemperature = true;
            continue;
          }

          throw new Error(`HTTP error ${response.status}: ${errorText}`);
        }

        const data = (await response.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
          usage?: {
            prompt_tokens?: number;
            completion_tokens?: number;
            total_tokens?: number;
          };
        };

        const choice = data.choices?.[0];
        const content = choice?.message?.content;
        if (typeof content !== 'string') {
          throw new Error('Invalid response structure: content not found in choice');
        }

        const usage: LLMUsage | undefined = data.usage ? {
          promptTokens: data.usage.prompt_tokens,
          completionTokens: data.usage.completion_tokens,
          totalTokens: data.usage.total_tokens
        } : undefined;

        return { content, usage };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        throw new Error(this.redact(errMsg));
      }
    }
  }

  async testConnection(): Promise<{ success: boolean; usage?: LLMUsage; error?: string }> {
    try {
      const res = await this.execute({
        messages: [{ role: 'user', content: 'Ping' }],
        maxTokens: 5
      });
      return { success: true, usage: res.usage };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err)
      };
    }
  }
}

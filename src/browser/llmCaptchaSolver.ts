import type { LLMProvider } from '../llm/provider.js';
import type { LLMUsage, LLMMessageContent, LLMResponse } from '../llm/types.js';
import { redactLLMSecrets } from '../llm/redactor.js';

export type CaptchaKind = 'text_prompt' | 'image_prompt' | 'unsupported_widget';
export type CaptchaSolverProvider = 'configured_llm';

export interface CaptchaChallenge {
  kind: Exclude<CaptchaKind, 'unsupported_widget'>;
  pageUrl: string;
  promptText: string;
  inputSelector: string;
  submitSelector?: string;
  imageDataUrl?: string;
}

export interface CaptchaSolveResult {
  success: boolean;
  provider: CaptchaSolverProvider;
  kind: CaptchaKind;
  status: 'solved' | 'failed' | 'unsupported' | 'not_configured';
  answer?: string;
  model?: string;
  error?: string;
  elapsedMs: number;
  usage?: LLMUsage;
}

export interface CaptchaSolver {
  solve(challenge: CaptchaChallenge): Promise<CaptchaSolveResult>;
}

function isCaptchaResponse(obj: unknown): obj is { answer: unknown } {
  return typeof obj === 'object' && obj !== null && 'answer' in obj;
}

export class LlmCaptchaSolver implements CaptchaSolver {
  private readonly provider: LLMProvider;

  constructor(provider: LLMProvider) {
    this.provider = provider;
  }

  async solve(challenge: CaptchaChallenge): Promise<CaptchaSolveResult> {
    const startTime = Date.now();
    const kind = challenge.kind;

    let response: LLMResponse | undefined;

    try {
      const sanitizedPrompt = (challenge.promptText || '')
        .replace(/\s+/g, ' ')
        .replace(/[\x00-\x1F\x7F-\x9F]/g, '')
        .trim()
        .slice(0, 1000);

      let userContent: LLMMessageContent;
      if (kind === 'image_prompt') {
        if (!challenge.imageDataUrl) {
          throw new Error('Image URL is missing for image_prompt');
        }
        userContent = [
          { type: 'text', text: sanitizedPrompt },
          { type: 'image_url', image_url: { url: challenge.imageDataUrl } }
        ];
      } else {
        userContent = `Challenge text:\n${sanitizedPrompt}`;
      }

      response = await this.provider.execute({
        messages: [
          {
            role: 'system',
            content: 'You solve only site-owner-authorized job-application CAPTCHA prompts. Return strict JSON only: {"answer":"ANSWER"} with the exact characters or numeric result that should be typed into the CAPTCHA answer field. Do not include explanations. If the prompt is not directly answerable from the provided text/image, return {"answer":""}.'
          },
          {
            role: 'user',
            content: userContent
          }
        ],
        responseFormat: { type: 'json_object' },
        temperature: 1,
        maxTokens: 64
      });

      const content = response.content;
      let jsonText = content.trim();
      if (jsonText.startsWith('```')) {
        jsonText = jsonText.replace(/^```[a-zA-Z]*\s*/, '').replace(/\s*```$/, '');
      }

      const parsed: unknown = JSON.parse(jsonText);
      if (!isCaptchaResponse(parsed)) {
        throw new Error('Response is missing answer property');
      }

      const rawAnswer = parsed.answer;
      if (typeof rawAnswer !== 'string') {
        throw new Error('Answer is not a string');
      }

      const trimmedAnswer = rawAnswer.trim();
      if (trimmedAnswer.length < 1) {
        throw new Error('Answer is empty');
      }
      if (trimmedAnswer.length > 128) {
        throw new Error('Answer exceeds maximum length of 128 characters');
      }
      if (/[\x00-\x1F\x7F-\x9F]/.test(trimmedAnswer)) {
        throw new Error('Answer contains control characters');
      }
      if (trimmedAnswer.includes('://') || trimmedAnswer.includes('www.')) {
        throw new Error('Answer contains URL-like substrings');
      }

      const elapsedMs = Date.now() - startTime;
      return {
        success: true,
        provider: 'configured_llm',
        kind,
        status: 'solved',
        answer: trimmedAnswer,
        model: this.provider.config.model,
        elapsedMs,
        usage: response.usage
      };
    } catch (error) {
      const elapsedMs = Date.now() - startTime;
      const rawErrorMessage = error instanceof Error ? error.message : String(error);
      
      const secrets = this.provider.config.apiKey ? [this.provider.config.apiKey] : [];
      const redactedError = redactLLMSecrets(rawErrorMessage, secrets);

      return {
        success: false,
        provider: 'configured_llm',
        kind,
        status: 'failed',
        error: redactedError,
        elapsedMs,
        usage: response?.usage
      };
    }
  }
}

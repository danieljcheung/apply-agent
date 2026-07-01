import type { ProtonBridgeConfigInput } from '../protonBridge.js';

export function redactCredentials(text: string | undefined | null, config?: ProtonBridgeConfigInput | null): string {
  if (!text) return '';
  let sanitized = String(text);
  if (config) {
    if (config.password && typeof config.password === 'string' && config.password.length > 0) {
      sanitized = sanitized.split(config.password).join('[REDACTED]');
    }
    if (config.username && typeof config.username === 'string' && config.username.length > 0) {
      sanitized = sanitized.split(config.username).join('[REDACTED]');
    }
  }
  // Generic pattern matching for sensitive key/value assignments
  sanitized = sanitized.replace(/(password|pass|token|secret)=([^\s&]+)/gi, '$1=[REDACTED]');
  return sanitized;
}

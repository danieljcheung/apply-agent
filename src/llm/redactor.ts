export function redactLLMSecrets(text: string, secrets: string[] = []): string {
  if (!text) return '';
  let sanitized = String(text);

  for (const secret of secrets) {
    if (secret && typeof secret === 'string' && secret.trim().length > 3) {
      const escaped = secret.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
      const regex = new RegExp(escaped, 'gi');
      sanitized = sanitized.replace(regex, '[REDACTED]');
    }
  }

  // Redact Authorization headers or Bearer tokens
  sanitized = sanitized.replace(/bearer\s+[a-z0-9_\-\.\~\+\/=]+/gi, 'Bearer [REDACTED]');
  
  // Redact query parameter patterns like api_key=xyz, secret=abc
  sanitized = sanitized.replace(/(api[-_]?key|apikey|secret|token|pass|password)=([a-z0-9_\-\.\~\+\/=]+)/gi, '$1=[REDACTED]');
  
  // Redact JSON properties like "apiKey": "xyz", "secret": "abc"
  sanitized = sanitized.replace(/(api[-_]?key|apikey|secret|token|pass|password)["']?\s*:\s*["']([a-z0-9_\-\.\~\+\/=]+)["']/gi, '$1":"[REDACTED]"');

  return sanitized;
}

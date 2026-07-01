import type { LLMProviderConfig } from './types.js';

export function redactProviderConfig(config: LLMProviderConfig): LLMProviderConfig {
  return {
    ...config,
    apiKey: config.apiKey ? '********' : undefined
  };
}

function rawLLMProviders(vaultData: Record<string, unknown>): LLMProviderConfig[] {
  if (vaultData && Array.isArray(vaultData.llmProviders)) {
    return vaultData.llmProviders as LLMProviderConfig[];
  }
  return [];
}

export function getLLMProviders(vaultData: Record<string, unknown>): LLMProviderConfig[] {
  return rawLLMProviders(vaultData).map(redactProviderConfig);
}

export function saveLLMProvider(
  vaultData: Record<string, unknown>,
  config: LLMProviderConfig
): Record<string, unknown> {
  const providers = rawLLMProviders(vaultData);
  const existing = providers.find(p => p.id === config.id);
  const keyRef = config.apiKeyRef || existing?.apiKeyRef || `secret_${config.id}`;
  const llmSecrets = {
    ...((vaultData.llmSecrets && typeof vaultData.llmSecrets === 'object') ? vaultData.llmSecrets as Record<string, string> : {})
  };

  if (config.apiKey && config.apiKey !== '********' && config.apiKey !== '[REDACTED]' && config.apiKey.trim() !== '') {
    llmSecrets[keyRef] = config.apiKey.trim();
  }

  const newConfig: LLMProviderConfig = {
    ...config,
    apiKeyRef: keyRef,
    apiKey: undefined
  };

  const updatedProviders = existing
    ? providers.map(p => (p.id === config.id ? newConfig : p))
    : [...providers, newConfig];

  return {
    ...vaultData,
    llmProviders: updatedProviders,
    llmSecrets
  };
}

export function deleteLLMProvider(
  vaultData: Record<string, unknown>,
  id: string
): Record<string, unknown> {
  const providers = rawLLMProviders(vaultData);
  return {
    ...vaultData,
    llmProviders: providers.filter(p => p.id !== id)
  };
}

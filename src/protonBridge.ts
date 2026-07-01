import { ImapClient } from './mail/imapClient.js';
import { redactCredentials } from './mail/redactor.js';

export type ProtonBridgeConfigInput = { host?: string; port?: number | string; username?: string; password?: string; simulateSuccess?: boolean; secure?: boolean; rejectUnauthorized?: boolean };

export function resolveProtonBridgeConfig(config: ProtonBridgeConfigInput | null = null): ProtonBridgeConfigInput | null {
  const host = config?.host || process.env.PROTON_BRIDGE_HOST || '127.0.0.1';
  const rawPort = config?.port || process.env.PROTON_BRIDGE_PORT || 1143;
  const port = typeof rawPort === 'string' ? parseInt(rawPort, 10) || rawPort : rawPort;
  const username = config?.username || process.env.PROTON_BRIDGE_USERNAME;
  const password = config?.password || process.env.PROTON_BRIDGE_PASSWORD || process.env.PROTON_BRIDGE_TOKEN;
  let simulateSuccess = config?.simulateSuccess ?? (process.env.PROTON_BRIDGE_SIMULATE === 'true');

  const isProd = process.env.NODE_ENV === 'production';
  if (isProd) {
    simulateSuccess = false;
  }

  const isLoopback = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  const configSecure = config?.secure ?? (process.env.PROTON_BRIDGE_SECURE !== undefined ? process.env.PROTON_BRIDGE_SECURE === 'true' : undefined);
  const configReject = config?.rejectUnauthorized ?? (process.env.PROTON_BRIDGE_REJECT_UNAUTHORIZED !== undefined ? process.env.PROTON_BRIDGE_REJECT_UNAUTHORIZED === 'true' : undefined);

  const secure = configSecure ?? !isLoopback;
  const rejectUnauthorized = configReject ?? !isLoopback;

  if (username && password) {
    return {
      host,
      port,
      username,
      password,
      simulateSuccess,
      secure,
      rejectUnauthorized
    };
  }
  if (config) {
    return {
      ...config,
      host,
      port,
      username,
      password,
      simulateSuccess,
      secure,
      rejectUnauthorized
    };
  }
  return null;
}

export class ProtonBridgeConnector {
  private config: ProtonBridgeConfigInput | null;
  private connected: boolean;
  private imapClient: ImapClient | null;

  constructor(config: ProtonBridgeConfigInput | null = null) {
    this.config = resolveProtonBridgeConfig(config);
    this.connected = false;
    this.imapClient = null;
  }

  testConfig(config: ProtonBridgeConfigInput | null): boolean {
    const cfg = resolveProtonBridgeConfig(config);
    if (!cfg) return false;
    const required = ['host', 'port', 'username', 'password'];
    const hasRequired = required.every(key => {
      const val = (cfg as Record<string, unknown>)[key];
      return typeof val === 'string' || typeof val === 'number';
    });
    if (!hasRequired) return false;

    const host = String(cfg.host);
    const isLoopback = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
    if (!isLoopback) {
      if (cfg.secure !== true || cfg.rejectUnauthorized !== true) {
        return false;
      }
    }
    return true;
  }

  buildImapCommand(tag: string, command: string, ...args: string[]): string {
    const parts = [tag, command];
    if (args.length > 0) {
      parts.push(...args);
    }
    return parts.join(' ') + '\r\n';
  }

  parseImapResponse(response: string): unknown {
    if (!response) return { status: 'BAD', lines: [] };
    const lines = response.split('\r\n').map(l => l.trim()).filter(Boolean);
    const parsed = {
      lines,
      status: 'OK',
      exists: null,
      searchResults: []
    };

    for (const line of lines) {
      if (line.startsWith('*')) {
        const parts = line.split(' ');
        if (parts[2] === 'EXISTS') {
          parsed.exists = parseInt(parts[1], 10);
        } else if (parts[1] === 'SEARCH') {
          parsed.searchResults = parts.slice(2).map(id => parseInt(id, 10)).filter(id => !isNaN(id));
        }
      } else {
        const parts = line.split(' ');
        const statusIdx = parts.findIndex(p => p === 'OK' || p === 'NO' || p === 'BAD');
        if (statusIdx !== -1) {
          parsed.status = parts[statusIdx];
        }
      }
    }
    return parsed;
  }

  async connect(): Promise<unknown> {
    if (!this.config || !this.testConfig(this.config)) {
      return {
        connected: false,
        blocker: 'BRIDGE_CONFIG_INVALID',
        message: 'Proton Bridge configuration is missing or invalid.'
      };
    }
    
    const isProd = process.env.NODE_ENV === 'production';
    const isTest = process.env.TEST_MODE === 'true';
    const simulateSuccess = (isProd || !isTest) ? false : !!this.config.simulateSuccess;
    if (simulateSuccess) {
      this.connected = true;
      return { connected: true };
    }

    try {
      this.imapClient = new ImapClient(this.config);
      const res = await this.imapClient.connect();
      this.connected = res.connected;
      return res;
    } catch (err) {
      this.connected = false;
      const rawMessage = err instanceof Error ? err.message : String(err);
      return {
        connected: false,
        blocker: 'BRIDGE_UNAVAILABLE',
        message: this.redactError(rawMessage)
      };
    }
  }

  async close(): Promise<void> {
    this.connected = false;
    if (this.imapClient) {
      await this.imapClient.close();
      this.imapClient = null;
    }
  }

  async logout(): Promise<void> {
    await this.close();
  }

  async search(query: string): Promise<unknown> {
    if (!this.connected) {
      return {
        success: false,
        blocker: 'BRIDGE_NOT_CONNECTED',
        message: 'Proton Bridge is not connected.'
      };
    }

    if (this.config && this.config.simulateSuccess) {
      const queryLower = query ? query.toLowerCase() : '';
      const allMockEmails = [
        { id: 1, subject: 'Workday Verification Code', body: 'Your verification code is 884712', from: 'no-reply@workday.com' },
        { id: 2, subject: 'Job Application Received', body: 'Thank you for your application to TechCorp.', from: 'jobs@techcorp.workday.com' }
      ];

      const filtered = allMockEmails.filter(email => 
        email.subject.toLowerCase().includes(queryLower) || 
        email.body.toLowerCase().includes(queryLower)
      );

      return {
        success: true,
        emails: filtered
      };
    }

    if (!this.imapClient) {
      return {
        success: false,
        blocker: 'BRIDGE_NOT_CONNECTED',
        message: 'Proton Bridge is not connected.'
      };
    }

    try {
      const emails = await this.imapClient.searchInbox(query);
      return {
        success: true,
        emails
      };
    } catch (err) {
      const rawMessage = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        blocker: 'BRIDGE_SEARCH_FAILED',
        message: this.redactError(rawMessage)
      };
    }
  }

  redactError(errorMessage: string): string {
    return redactCredentials(errorMessage, this.config);
  }
}

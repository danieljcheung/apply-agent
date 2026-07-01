import { ImapFlow, type SearchObject } from 'imapflow';
import type { ProtonBridgeConfigInput } from '../protonBridge.js';
import type { ImapConnectResult, NormalizedEmail } from './types.js';
import { redactCredentials } from './redactor.js';

export class ImapClient {
  private client: ImapFlow | null = null;
  private connected: boolean = false;
  private config: ProtonBridgeConfigInput;

  constructor(config: ProtonBridgeConfigInput) {
    this.config = config;
  }

  async connect(): Promise<ImapConnectResult> {
    try {
      const host = this.config.host || '127.0.0.1';
      const isLoopback = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
      const secure = isLoopback ? (this.config.secure ?? false) : true;
      const rejectUnauthorized = isLoopback ? (this.config.rejectUnauthorized ?? false) : true;

      this.client = new ImapFlow({
        host,
        port: typeof this.config.port === 'number' ? this.config.port : parseInt(String(this.config.port || 1143), 10),
        secure,
        tls: {
          rejectUnauthorized
        },
        auth: {
          user: this.config.username || '',
          pass: this.config.password || ''
        },
        logger: false
      });

      await this.client.connect();
      this.connected = true;
      return { connected: true };
    } catch (err) {
      this.connected = false;
      await this.close();
      const rawMessage = err instanceof Error ? err.message : String(err);
      return {
        connected: false,
        blocker: 'BRIDGE_UNAVAILABLE',
        message: redactCredentials(rawMessage, this.config)
      };
    }
  }

  async close(): Promise<void> {
    this.connected = false;
    if (this.client) {
      try {
        await this.client.logout();
      } catch {
        // Ignored logout error on teardown
      } finally {
        this.client = null;
      }
    }
  }

  async searchInbox(query: string): Promise<NormalizedEmail[]> {
    if (!this.client || !this.connected) {
      throw new Error('Proton Bridge is not connected.');
    }

    let lock: { release: () => void } | null = null;
    try {
      lock = await this.client.getMailboxLock('INBOX', { readOnly: true });

      const searchObject: SearchObject = {};
      const trimmedQuery = query ? query.trim() : '';
      if (trimmedQuery && trimmedQuery !== '*') {
        searchObject.or = [
          { subject: trimmedQuery },
          { body: trimmedQuery }
        ];
      } else {
        searchObject.all = true;
      }

      const uids = await this.client.search(searchObject, { uid: true });
      if (!Array.isArray(uids) || uids.length === 0) {
        return [];
      }

      const recentUids = uids.slice(-50);
      const messages = await this.client.fetchAll(recentUids, {
        envelope: true,
        source: true
      }, { uid: true });

      const results: NormalizedEmail[] = [];
      for (const msg of messages) {
        let body = '';
        if (msg.source && msg.source.length > 0) {
          const raw = msg.source.toString('utf-8');
          const headerEnd = raw.indexOf('\r\n\r\n');
          const headerEndAlt = raw.indexOf('\n\n');
          const bodyStart = headerEnd !== -1 ? headerEnd + 4 : (headerEndAlt !== -1 ? headerEndAlt + 2 : -1);
          body = bodyStart !== -1 ? raw.slice(bodyStart).trim() : raw.trim();
        }

        const sender = msg.envelope?.from?.[0];
        const fromAddr = sender?.address || sender?.name || 'unknown';

        results.push({
          id: msg.uid,
          subject: msg.envelope?.subject || '(No Subject)',
          body,
          from: fromAddr,
          date: msg.envelope?.date,
          messageId: msg.envelope?.messageId
        });
      }
      return results;
    } finally {
      if (lock) {
        try {
          lock.release();
        } catch {
          // Ignore lock release error
        }
      }
    }
  }
}

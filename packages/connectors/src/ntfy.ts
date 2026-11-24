import { HomemcpError } from '@homemcp/core';
import { fetchWithTimeout } from './http.js';

export type NtfyPriority = 1 | 2 | 3 | 4 | 5;

export interface NtfyMessage {
  title: string;
  message: string;
  priority?: NtfyPriority | undefined;
  tags?: string[] | undefined;
}

export interface NtfyConnector {
  send(msg: NtfyMessage): Promise<void>;
}

export class HttpNtfyConnector implements NtfyConnector {
  private readonly topicUrl: string;
  private readonly token: string | undefined;

  public constructor(opts: { url: string; token?: string | undefined }) {
    this.topicUrl = opts.url.replace(/\/+$/, '');
    this.token = opts.token;
  }

  public async send(msg: NtfyMessage): Promise<void> {
    const headers: Record<string, string> = {
      Title: msg.title,
      Priority: String(msg.priority ?? 3),
    };
    if (msg.tags && msg.tags.length > 0) {
      headers['Tags'] = msg.tags.join(',');
    }
    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }

    const resp = await fetchWithTimeout(this.topicUrl, {
      method: 'POST',
      headers,
      body: msg.message,
      timeoutMs: 8_000,
      serviceName: 'ntfy',
    });

    if (resp.status === 401 || resp.status === 403) {
      throw new HomemcpError('UPSTREAM_AUTH', `ntfy rejected token (${resp.status})`);
    }
    if (!resp.ok) {
      throw new HomemcpError('UPSTREAM_UNAVAILABLE', `ntfy HTTP ${resp.status}`);
    }
  }
}

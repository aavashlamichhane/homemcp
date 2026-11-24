import { fetchWithTimeout } from './http.js';

export interface HealthchecksConnector {
  ping(state?: 'ok' | 'start' | 'fail'): Promise<boolean>;
}

export class HttpHealthchecksConnector implements HealthchecksConnector {
  private readonly pingUrl: string;

  public constructor(opts: { pingUrl: string }) {
    this.pingUrl = opts.pingUrl.replace(/\/+$/, '');
  }

  public async ping(state: 'ok' | 'start' | 'fail' = 'ok'): Promise<boolean> {
    const target = state === 'ok' ? this.pingUrl : `${this.pingUrl}/${state}`;
    try {
      const resp = await fetchWithTimeout(target, {
        method: 'GET',
        timeoutMs: 5_000,
        serviceName: 'healthchecks',
      });
      return resp.ok;
    } catch {
      return false;
    }
  }
}

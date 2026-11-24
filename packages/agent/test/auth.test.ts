import { describe, expect, it } from 'vitest';
import { NonceReplayCache, signAgentRequest, verifyAgentRequest } from '../src/auth.js';

describe('agent HMAC auth', () => {
  const secret = 'test-hmac-secret-1234567890';

  it('accepts valid signed requests and rejects replay of the same nonce', () => {
    const cache = new NonceReplayCache(60_000);
    const body = JSON.stringify({ verb: 'system.health', params: {} });
    const now = 1_700_000_000_000;
    const headers = signAgentRequest(secret, 'POST', body, now);

    expect(() =>
      verifyAgentRequest(
        {
          secret,
          method: 'POST',
          rawBody: body,
          tsHeader: headers['x-homemcp-ts'],
          nonceHeader: headers['x-homemcp-nonce'],
          sigHeader: headers['x-homemcp-sig'],
        },
        cache,
        now + 5_000,
      ),
    ).not.toThrow();

    // Replay with identical nonce must fail
    expect(() =>
      verifyAgentRequest(
        {
          secret,
          method: 'POST',
          rawBody: body,
          tsHeader: headers['x-homemcp-ts'],
          nonceHeader: headers['x-homemcp-nonce'],
          sigHeader: headers['x-homemcp-sig'],
        },
        cache,
        now + 6_000,
      ),
    ).toThrow(/Replay/);
  });

  it('rejects requests outside ±30s skew or with tampered body', () => {
    const cache = new NonceReplayCache();
    const body = '{"verb":"system.health","params":{}}';
    const now = 1_700_000_000_000;
    const headers = signAgentRequest(secret, 'POST', body, now);

    expect(() =>
      verifyAgentRequest(
        {
          secret,
          method: 'POST',
          rawBody: body,
          tsHeader: headers['x-homemcp-ts'],
          nonceHeader: headers['x-homemcp-nonce'],
          sigHeader: headers['x-homemcp-sig'],
        },
        cache,
        now + 45_000,
      ),
    ).toThrow(/skew/);

    expect(() =>
      verifyAgentRequest(
        {
          secret,
          method: 'POST',
          rawBody: '{"verb":"system.reboot","params":{}}',
          tsHeader: headers['x-homemcp-ts'],
          nonceHeader: headers['x-homemcp-nonce'],
          sigHeader: headers['x-homemcp-sig'],
        },
        cache,
        now + 1_000,
      ),
    ).toThrow(/Invalid HMAC/);
  });
});

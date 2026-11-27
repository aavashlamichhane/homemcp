import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { parseConfigObject, parseDurationMs } from '../src/config.js';
import { ConfigError } from '../src/errors.js';
import { Redactor } from '../src/redact.js';

describe('config loader', () => {
  it('validates examples/homemcp.config.example.yaml and registers env secrets in Redactor', async () => {
    const examplePath = path.resolve(
      import.meta.dirname,
      '../../../examples/homemcp.config.example.yaml',
    );
    const rawYaml = parseYaml(await readFile(examplePath, 'utf8'));
    const redactor = new Redactor();

    const env: Record<string, string> = {
      HOMEMCP_SECRET_KEY: 'test-secret-key-0001',
      HOMEMCPD_HMAC_SECRET: 'test-hmac-secret-0002',
      NPM_EMAIL: 'mcp@example.com',
      NPM_PASSWORD: 'test-npm-password-0003',
      CF_ACCOUNT_ID: 'acc-123',
      CF_TUNNEL_ID: 'tun-456',
      CF_API_TOKEN: 'test-cf-token-0004',
      NAVIDROME_USER: 'owner',
      NAVIDROME_PASSWORD: 'test-navidrome-pass-0005',
      NAVILOAD_TOKEN: 'test-naviload-token-0006',
      JELLYFIN_API_KEY: 'test-jellyfin-key-0007',
      QBIT_USER: 'admin',
      QBIT_PASSWORD: 'test-qbit-pass-0008',
      JACKETT_API_KEY: 'test-jackett-key-0009',
      NTFY_URL: 'https://ntfy.sh/test-private-topic-9999',
      NTFY_TOKEN: 'tk_testntfytoken000000000001',
      HC_URL_HOMEMCP: 'https://hc-ping.com/11111111-1111-1111-1111-111111111111',
    };

    const cfg = parseConfigObject(rawYaml, env, redactor);
    expect(cfg.server.publicUrl).toBe('https://homemcp.example.com');
    expect(cfg.modules.navidrome?.password).toBe('test-navidrome-pass-0005');

    const check = redactor.redactString('leaked test-navidrome-pass-0005 here');
    expect(check.count).toBe(1);
    expect(check.text).not.toContain('test-navidrome-pass-0005');
  });

  it('throws ConfigError naming missing env var without printing values', () => {
    expect(() =>
      parseConfigObject(
        {
          server: { publicUrl: 'https://homemcp.example.com' },
          auth: {
            issuer: 'https://homemcp.example.com',
            owner: { name: 'Owner' },
            secretKey: 'env:MISSING_KEY_XYZ',
          },
          agent: { hmacSecret: 'env:HMAC_KEY' },
          policy: { roots: { stacks: '/srv/stacks', media: '/srv/media' } },
          modules: {},
        },
        { HMAC_KEY: 'secret' },
      ),
    ).toThrow(ConfigError);

    try {
      parseConfigObject(
        {
          server: { publicUrl: 'https://homemcp.example.com' },
          auth: {
            issuer: 'https://homemcp.example.com',
            owner: { name: 'Owner' },
            secretKey: 'env:MISSING_KEY_XYZ',
          },
          agent: { hmacSecret: 'env:HMAC_KEY' },
          policy: { roots: { stacks: '/srv/stacks', media: '/srv/media' } },
          modules: {},
        },
        { HMAC_KEY: 'do-not-leak-this-secret' },
      );
    } catch (err) {
      expect((err as Error).message).toContain('MISSING_KEY_XYZ');
      expect((err as Error).message).not.toContain('do-not-leak-this-secret');
    }
  });

  it('throws ConfigError on env var containing newline characters without leaking the value', () => {
    try {
      parseConfigObject(
        {
          server: { publicUrl: 'https://homemcp.example.com' },
          auth: {
            issuer: 'https://homemcp.example.com',
            owner: { name: 'Owner' },
            secretKey: 'env:NEWLINE_SECRET',
          },
          agent: { hmacSecret: 'env:HMAC_KEY' },
          policy: { roots: { stacks: '/srv/stacks', media: '/srv/media' } },
          modules: {},
        },
        { NEWLINE_SECRET: '\nshould-not-leak-secret', HMAC_KEY: 'secret' },
      );
      expect.fail('Expected ConfigError');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as Error).message).toContain('NEWLINE_SECRET');
      expect((err as Error).message).not.toContain('should-not-leak-secret');
    }
  });

  it('parses duration strings accurately', () => {
    expect(parseDurationMs('15m')).toBe(900_000);
    expect(parseDurationMs('24h')).toBe(86_400_000);
    expect(parseDurationMs('8d')).toBe(691_200_000);
  });
});

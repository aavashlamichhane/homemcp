import { describe, expect, it } from 'vitest';
import { isDeniedPath, Redactor, shannonEntropy } from '../src/redact.js';

describe('Redactor', () => {
  it('redacts exact registered secrets across strings and nested objects', () => {
    const redactor = new Redactor();
    const fakeSecret = 'super-secret-value-987654321';
    redactor.registerSecret(fakeSecret);

    const input = {
      message: `Connected with ${fakeSecret}`,
      nested: [{ detail: fakeSecret }],
    };
    const res = redactor.redactValue(input);
    expect(res.redactionCount).toBe(2);
    expect(JSON.stringify(res.value)).not.toContain(fakeSecret);
    expect(res.value.message).toMatch(/«redacted:secret:[0-9a-f]{4}»/);
  });

  it('redacts cloudflared --token and base64 tunnel JSON patterns', () => {
    const redactor = new Redactor();
    const fakeTunnelTok =
      'eyJhIjoiYWJjZGVmMDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTIzIiwidCI6IjAwMDAwMDAwLTAwMDAtMDAwMC0wMDAwLTAwMDAwMDAwMDAwMCIsInMiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ejAxMjM0NTY3ODkifQ==';
    const cmd = `cloudflared tunnel --no-autoupdate --protocol quic run --token ${fakeTunnelTok}`;
    const res = redactor.redactString(cmd);
    expect(res.count).toBeGreaterThanOrEqual(1);
    expect(res.text).not.toContain('eyJhIjoi');
    expect(res.text).toContain('«redacted:');
  });

  it('redacts Navidrome/NaviLoad env keys and secret-named object fields', () => {
    const redactor = new Redactor();
    const envText = [
      'MUSIC_HOST_PATH=/mnt/storage/media/music',
      'DOWNLOADER_PASSWORD=my-fake-downloader-pass',
      'ACOUSTID_API_KEY=fakeAcoustidKey99',
      'NAVILOAD_API_TOKEN_HASH=abcdef0123456789abcdef0123456789',
      'PORT=8085',
    ].join('\n');

    const res = redactor.redactString(envText);
    expect(res.text).toContain('MUSIC_HOST_PATH=/mnt/storage/media/music');
    expect(res.text).toContain('PORT=8085');
    expect(res.text).not.toContain('my-fake-downloader-pass');
    expect(res.text).not.toContain('fakeAcoustidKey99');
    expect(res.text).not.toContain('abcdef0123456789abcdef0123456789');

    const objRes = redactor.redactValue({
      apiKey: 'secret-api-key-val',
      idempotency_key: 'idem-12345',
      token_kind: 'oauth',
    });
    expect(objRes.value.apiKey).toMatch(/^«redacted:field:/);
    expect(objRes.value.idempotency_key).toBe('idem-12345');
    expect(objRes.value.token_kind).toBe('oauth');
  });

  it('redacts JWTs, PEM blocks, Authorization headers, Cookie headers, URL userinfo, and known token prefixes', () => {
    const redactor = new Redactor();
    const samples = [
      'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJvd25lciJ9.signaturepart123',
      'Cookie: session=abc123def456; csrf=xyz',
      'postgres://admin:verysecretpass@db.example.com:5432/app',
      'ghp_1234567890abcdef1234567890abcdef1234',
      'gsk_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789',
      'sk-or-v1-1234567890abcdef1234567890abcdef',
      'AKIAIOSFODNN7EXAMPLE',
      'tk_0123456789abcdef01234567',
      'hmp_abcdef0123456789abcdef0123456789',
      '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC\n-----END PRIVATE KEY-----',
    ];

    for (const s of samples) {
      const res = redactor.redactString(s);
      expect(res.count).toBeGreaterThanOrEqual(1);
      expect(res.text).toContain('«redacted:');
    }
  });

  it('does NOT falsely redact safe UUIDs, sha256 image digests, file paths, or plain URLs', () => {
    const redactor = new Redactor();
    const safe = {
      uuid: '123e4567-e89b-12d3-a456-426614174000',
      digest:
        'deluan/navidrome@sha256:9012939114fbb1bb641b81cf96dec5ded15f0aafefe8d47a511d7cb919658e40',
      path: '/mnt/storage/media/music/artist/album/track.m4a',
      url: 'https://homemcp.example.com/mcp',
      args: [
        'sha256:9012939114fbb1bb641b81cf96dec5ded15f0aafefe8d47a511d7cb919658e40',
        '/opt/homemcp/gateway/dist/index.js',
      ],
    };
    const res = redactor.redactValue(safe);
    expect(res.redactionCount).toBe(0);
    expect(res.value).toEqual(safe);
  });

  it('redacts high-entropy tokens in env/args context', () => {
    const redactor = new Redactor();
    const highEntropy = 'X9kL2pQ8mR5vW3zB7nC4jF6hT1yD9sA0eG';
    expect(shannonEntropy(highEntropy)).toBeGreaterThan(4.0);
    const res = redactor.redactValue({
      args: ['--secret-flag', highEntropy],
    });
    expect(res.redactionCount).toBe(1);
    expect(res.value.args[1]).toMatch(/^«redacted:entropy:/);
  });

  it('identifies denied file paths while allowing .env.example', () => {
    expect(isDeniedPath('/home/homelab/stacks/app/.env')).toBe(true);
    expect(isDeniedPath('/home/homelab/stacks/app/.env.docker')).toBe(true);
    expect(isDeniedPath('/home/homelab/stacks/app/.env.example')).toBe(false);
    expect(isDeniedPath('/home/homelab/.ssh/authorized_keys')).toBe(true);
    expect(isDeniedPath('/mnt/storage/keys.json')).toBe(true);
    expect(isDeniedPath('/mnt/storage/app.sqlite3')).toBe(true);
    expect(isDeniedPath('/home/homelab/stacks/app/docker-compose.yml')).toBe(false);
  });
});

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { HomemcpError } from '@homemcp/core';

export interface HmacHeaders {
  'x-homemcp-ts': string;
  'x-homemcp-nonce': string;
  'x-homemcp-sig': string;
}

export function computeBodySha256(rawBody: string | Buffer): string {
  return createHash('sha256').update(rawBody).digest('hex');
}

export function computeSignature(
  secret: string,
  ts: string,
  method: string,
  rawBody: string | Buffer,
): string {
  const payload = `${ts}\n${method.toUpperCase()}\n${computeBodySha256(rawBody)}`;
  return createHmac('sha256', secret).update(payload).digest('hex');
}

export function signAgentRequest(
  secret: string,
  method: string,
  rawBody: string | Buffer,
  nowMs: number = Date.now(),
): HmacHeaders {
  const ts = String(Math.floor(nowMs / 1000));
  const nonce = randomBytes(16).toString('hex');
  const sig = computeSignature(secret, ts, method, rawBody);
  return {
    'x-homemcp-ts': ts,
    'x-homemcp-nonce': nonce,
    'x-homemcp-sig': sig,
  };
}

export class NonceReplayCache {
  private readonly seen = new Map<string, number>();

  public constructor(private readonly ttlMs: number = 60_000) {}

  public checkAndStore(nonce: string, nowMs: number = Date.now()): boolean {
    this.prune(nowMs);
    if (this.seen.has(nonce)) {
      return false;
    }
    this.seen.set(nonce, nowMs + this.ttlMs);
    return true;
  }

  private prune(nowMs: number): void {
    for (const [k, exp] of this.seen.entries()) {
      if (exp <= nowMs) {
        this.seen.delete(k);
      }
    }
  }
}

export function verifyAgentRequest(
  params: {
    secret: string;
    method: string;
    rawBody: string | Buffer;
    tsHeader: string | undefined;
    nonceHeader: string | undefined;
    sigHeader: string | undefined;
  },
  replayCache: NonceReplayCache,
  nowMs: number = Date.now(),
): void {
  const { secret, method, rawBody, tsHeader, nonceHeader, sigHeader } = params;
  if (!tsHeader || !nonceHeader || !sigHeader) {
    throw new HomemcpError('UPSTREAM_AUTH', 'Missing HMAC authentication headers');
  }
  if (!/^\d{10,13}$/.test(tsHeader)) {
    throw new HomemcpError('UPSTREAM_AUTH', 'Invalid timestamp header');
  }
  const tsSec = Number(tsHeader);
  const nowSec = Math.floor(nowMs / 1000);
  if (Math.abs(nowSec - tsSec) > 30) {
    throw new HomemcpError('UPSTREAM_AUTH', 'HMAC timestamp outside ±30s skew window');
  }
  if (!/^[a-f0-9]{16,64}$/i.test(nonceHeader)) {
    throw new HomemcpError('UPSTREAM_AUTH', 'Invalid nonce header');
  }
  const expected = computeSignature(secret, tsHeader, method, rawBody);
  const actualBuf = Buffer.from(sigHeader, 'utf8');
  const expectedBuf = Buffer.from(expected, 'utf8');
  if (actualBuf.length !== expectedBuf.length || !timingSafeEqual(actualBuf, expectedBuf)) {
    throw new HomemcpError('UPSTREAM_AUTH', 'Invalid HMAC signature');
  }
  if (!replayCache.checkAndStore(nonceHeader, nowMs)) {
    throw new HomemcpError('UPSTREAM_AUTH', 'Replay detected for request nonce');
  }
}

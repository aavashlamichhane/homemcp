import {
  argon2Sync,
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { exportJWK, generateKeyPair, importJWK, type JWK } from 'jose';

const ARGON2_PARAMS = {
  parallelism: 1,
  tagLength: 32,
  memory: 65536,
  passes: 3,
} as const;

export function hashSecret(plain: string): string {
  const nonce = randomBytes(16);
  const hash = argon2Sync('argon2id', {
    message: plain,
    nonce,
    ...ARGON2_PARAMS,
  });
  return `$argon2id$v=19$m=${ARGON2_PARAMS.memory},t=${ARGON2_PARAMS.passes},p=${ARGON2_PARAMS.parallelism}$${nonce.toString('base64')}$${hash.toString('base64')}`;
}

export function verifySecret(plain: string, storedPhc: string): boolean {
  const parts = storedPhc.split('$');
  // Expected: ['', 'argon2id', 'v=19', 'm=65536,t=3,p=1', '<nonceB64>', '<hashB64>']
  if (parts.length !== 6 || parts[1] !== 'argon2id') return false;
  const paramStr = parts[3] ?? '';
  const mMatch = /m=(\d+),t=(\d+),p=(\d+)/.exec(paramStr);
  if (!mMatch) return false;
  const memory = Number(mMatch[1]);
  const passes = Number(mMatch[2]);
  const parallelism = Number(mMatch[3]);
  const nonce = Buffer.from(parts[4] ?? '', 'base64');
  const expected = Buffer.from(parts[5] ?? '', 'base64');
  if (nonce.length === 0 || expected.length === 0) return false;

  const actual = argon2Sync('argon2id', {
    message: plain,
    nonce,
    memory,
    passes,
    parallelism,
    tagLength: expected.length,
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function deriveAesKey(secretKey: string): Buffer {
  return createHash('sha256').update(`homemcp-aes-key:${secretKey}`).digest();
}

export function encryptAtRest(plaintext: string, secretKey: string): string {
  const key = deriveAesKey(secretKey);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}.${tag.toString('base64')}.${enc.toString('base64')}`;
}

export function decryptAtRest(ciphertext: string, secretKey: string): string {
  const [ivB64, tagB64, encB64] = ciphertext.split('.');
  if (!ivB64 || !tagB64 || !encB64) {
    throw new Error('Malformed encrypted payload');
  }
  const key = deriveAesKey(secretKey);
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const enc = Buffer.from(encB64, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

export async function generateSigningKeyPair(): Promise<{
  kid: string;
  alg: string;
  publicJwk: JWK;
  privateJwk: JWK;
}> {
  const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true });
  const publicJwk = await exportJWK(publicKey);
  const privateJwk = await exportJWK(privateKey);
  const kid = createHash('sha256')
    .update(JSON.stringify(publicJwk))
    .digest('base64url')
    .slice(0, 16);
  publicJwk.kid = kid;
  publicJwk.alg = 'ES256';
  publicJwk.use = 'sig';
  privateJwk.kid = kid;
  privateJwk.alg = 'ES256';
  privateJwk.use = 'sig';
  return { kid, alg: 'ES256', publicJwk, privateJwk };
}

export { importJWK };

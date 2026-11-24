import { randomBytes } from 'node:crypto';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransport,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { authenticator } from 'otplib';
import QRCode from 'qrcode';
import { HomemcpError } from '@homemcp/core';
import type { HomemcpDb } from '../db/database.js';
import { decryptAtRest, encryptAtRest, hashSecret, verifySecret } from './crypto.js';

export interface StoredPasskey {
  credential_id: string;
  public_key: string;
  counter: number;
  transports: AuthenticatorTransport[];
  name: string;
  created_at: string;
  last_used_at: string | null;
}

export class OwnerAuthService {
  private readonly challenges = new Map<string, { challenge: string; expiresAt: number }>();

  public constructor(
    private readonly db: HomemcpDb,
    private readonly opts: {
      rpId: string;
      rpName: string;
      origin: string;
      secretKey: string;
      ownerName: string;
      onLockout?: (() => Promise<void> | void) | undefined;
    },
  ) {}

  public isBootstrapped(): boolean {
    const owner = this.db.db
      .prepare('SELECT bootstrapped_at FROM auth_owner WHERE id = ?')
      .get('owner') as { bootstrapped_at: string | null } | undefined;
    const passkeyCount = this.db.db.prepare('SELECT count(*) AS cnt FROM auth_passkeys').get() as {
      cnt: number;
    };
    return Boolean(owner?.bootstrapped_at) && passkeyCount.cnt > 0;
  }

  public listPasskeys(): StoredPasskey[] {
    const rows = this.db.db
      .prepare('SELECT * FROM auth_passkeys ORDER BY created_at ASC')
      .all() as Array<{
      credential_id: string;
      public_key: string;
      counter: number;
      transports_json: string | null;
      name: string;
      created_at: string;
      last_used_at: string | null;
    }>;
    return rows.map((r) => ({
      credential_id: r.credential_id,
      public_key: r.public_key,
      counter: r.counter,
      transports: r.transports_json
        ? (JSON.parse(r.transports_json) as AuthenticatorTransport[])
        : [],
      name: r.name,
      created_at: r.created_at,
      last_used_at: r.last_used_at,
    }));
  }

  public deletePasskey(credentialId: string): void {
    const count = this.listPasskeys().length;
    if (count <= 1) {
      throw new HomemcpError('POLICY_DENIED', 'Cannot delete the last remaining passkey');
    }
    this.db.db.prepare('DELETE FROM auth_passkeys WHERE credential_id = ?').run(credentialId);
  }

  public async beginPasskeyRegistration(sessionKey: string) {
    const existing = this.listPasskeys();
    const options = await generateRegistrationOptions({
      rpName: this.opts.rpName,
      rpID: this.opts.rpId,
      userName: this.opts.ownerName,
      userDisplayName: this.opts.ownerName,
      attestationType: 'none',
      excludeCredentials: existing.map((k) => ({
        id: k.credential_id,
        transports: k.transports,
      })),
      authenticatorSelection: {
        residentKey: 'preferred',
        userVerification: 'preferred',
      },
    });
    this.challenges.set(`reg:${sessionKey}`, {
      challenge: options.challenge,
      expiresAt: Date.now() + 300_000,
    });
    return options;
  }

  public async finishPasskeyRegistration(
    sessionKey: string,
    response: RegistrationResponseJSON,
    name = 'Passkey',
  ): Promise<StoredPasskey> {
    const stored = this.challenges.get(`reg:${sessionKey}`);
    this.challenges.delete(`reg:${sessionKey}`);
    if (!stored || stored.expiresAt < Date.now()) {
      throw new HomemcpError('INVALID_ARGUMENT', 'WebAuthn registration challenge expired');
    }

    const verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: stored.challenge,
      expectedOrigin: this.opts.origin,
      expectedRPID: this.opts.rpId,
      requireUserVerification: false,
    });
    if (!verification.verified || !verification.registrationInfo) {
      throw new HomemcpError('UPSTREAM_AUTH', 'Passkey registration verification failed');
    }

    const { credential } = verification.registrationInfo;
    const now = new Date().toISOString();
    const pubB64 = Buffer.from(credential.publicKey).toString('base64url');
    const transports = (credential.transports ?? []) as AuthenticatorTransport[];

    this.db.db
      .prepare(
        `INSERT INTO auth_passkeys (credential_id, public_key, counter, transports_json, name, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(credential.id, pubB64, credential.counter, JSON.stringify(transports), name, now);

    this.ensureOwnerRow(now);
    return {
      credential_id: credential.id,
      public_key: pubB64,
      counter: credential.counter,
      transports,
      name,
      created_at: now,
      last_used_at: null,
    };
  }

  public async beginPasskeyAuthentication(sessionKey: string) {
    const keys = this.listPasskeys();
    if (keys.length === 0) {
      throw new HomemcpError('NOT_FOUND', 'No passkeys registered');
    }
    const options = await generateAuthenticationOptions({
      rpID: this.opts.rpId,
      userVerification: 'preferred',
      allowCredentials: keys.map((k) => ({
        id: k.credential_id,
        transports: k.transports,
      })),
    });
    this.challenges.set(`auth:${sessionKey}`, {
      challenge: options.challenge,
      expiresAt: Date.now() + 300_000,
    });
    return options;
  }

  public async finishPasskeyAuthentication(
    sessionKey: string,
    response: AuthenticationResponseJSON,
  ): Promise<{ verified: boolean; credentialId: string; authTime: number }> {
    const stored = this.challenges.get(`auth:${sessionKey}`);
    this.challenges.delete(`auth:${sessionKey}`);
    if (!stored || stored.expiresAt < Date.now()) {
      throw new HomemcpError('INVALID_ARGUMENT', 'WebAuthn authentication challenge expired');
    }

    const keys = this.listPasskeys();
    const matched = keys.find((k) => k.credential_id === response.id);
    if (!matched) {
      throw new HomemcpError('UPSTREAM_AUTH', 'Unknown passkey credential');
    }

    const verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: stored.challenge,
      expectedOrigin: this.opts.origin,
      expectedRPID: this.opts.rpId,
      requireUserVerification: false,
      credential: {
        id: matched.credential_id,
        publicKey: new Uint8Array(Buffer.from(matched.public_key, 'base64url')),
        counter: matched.counter,
        transports: matched.transports,
      },
    });
    if (!verification.verified) {
      throw new HomemcpError('UPSTREAM_AUTH', 'Passkey assertion failed');
    }

    const nowIso = new Date().toISOString();
    this.db.db
      .prepare('UPDATE auth_passkeys SET counter = ?, last_used_at = ? WHERE credential_id = ?')
      .run(verification.authenticationInfo.newCounter, nowIso, matched.credential_id);

    return {
      verified: true,
      credentialId: matched.credential_id,
      authTime: Math.floor(Date.now() / 1000),
    };
  }

  public async setupTotp(): Promise<{
    secret: string;
    otpauthUri: string;
    qrDataUrl: string;
    recoveryCodes: string[];
  }> {
    const secret = authenticator.generateSecret();
    const otpauthUri = authenticator.keyuri(this.opts.ownerName, 'homemcp', secret);
    const qrDataUrl = await QRCode.toDataURL(otpauthUri);

    const enc = encryptAtRest(secret, this.opts.secretKey);
    this.ensureOwnerRow(new Date().toISOString());
    this.db.db.prepare('UPDATE auth_owner SET totp_secret_enc = ? WHERE id = ?').run(enc, 'owner');

    // Generate 10 one-time recovery codes
    this.db.db.prepare('DELETE FROM auth_recovery_codes').run();
    const codes: string[] = [];
    const insertCode = this.db.db.prepare(
      'INSERT INTO auth_recovery_codes (id, code_hash, used_at) VALUES (?, ?, NULL)',
    );
    for (let i = 0; i < 10; i++) {
      const code = `${randomBytes(3).toString('hex')}-${randomBytes(3).toString('hex')}`;
      codes.push(code);
      insertCode.run(`rc-${i + 1}`, hashSecret(code));
    }

    return { secret, otpauthUri, qrDataUrl, recoveryCodes: codes };
  }

  public async verifyTotpOrRecovery(
    codeInput: string,
    lockoutKey = 'owner-totp',
  ): Promise<boolean> {
    const now = Date.now();
    const lockRow = this.db.db
      .prepare('SELECT failures, window_start, locked_until FROM auth_lockouts WHERE key = ?')
      .get(lockoutKey) as
      { failures: number; window_start: number; locked_until: number | null } | undefined;

    if (lockRow?.locked_until && lockRow.locked_until > now) {
      throw new HomemcpError(
        'RATE_LIMITED',
        'Too many failed TOTP attempts; locked for 15 minutes',
      );
    }

    const clean = codeInput.trim();
    const owner = this.db.db
      .prepare('SELECT totp_secret_enc FROM auth_owner WHERE id = ?')
      .get('owner') as { totp_secret_enc: string | null } | undefined;

    let ok = false;
    if (owner?.totp_secret_enc && /^\d{6}$/.test(clean)) {
      const secret = decryptAtRest(owner.totp_secret_enc, this.opts.secretKey);
      ok = authenticator.check(clean, secret);
    }

    if (!ok && clean.includes('-')) {
      const unused = this.db.db
        .prepare('SELECT id, code_hash FROM auth_recovery_codes WHERE used_at IS NULL')
        .all() as Array<{ id: string; code_hash: string }>;
      for (const row of unused) {
        if (verifySecret(clean, row.code_hash)) {
          this.db.db
            .prepare('UPDATE auth_recovery_codes SET used_at = ? WHERE id = ?')
            .run(new Date().toISOString(), row.id);
          ok = true;
          break;
        }
      }
    }

    if (ok) {
      this.db.db.prepare('DELETE FROM auth_lockouts WHERE key = ?').run(lockoutKey);
      return true;
    }

    const windowMs = 15 * 60_000;
    const withinWindow = lockRow && now - lockRow.window_start < windowMs;
    const failures = withinWindow ? lockRow.failures + 1 : 1;
    const windowStart = withinWindow ? lockRow.window_start : now;
    const lockedUntil = failures >= 5 ? now + windowMs : null;

    this.db.db
      .prepare(
        `INSERT INTO auth_lockouts (key, failures, window_start, locked_until)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           failures = excluded.failures,
           window_start = excluded.window_start,
           locked_until = excluded.locked_until`,
      )
      .run(lockoutKey, failures, windowStart, lockedUntil);

    if (lockedUntil && this.opts.onLockout) {
      await this.opts.onLockout();
    }
    return false;
  }

  private ensureOwnerRow(ts: string): void {
    this.db.db
      .prepare(
        `INSERT INTO auth_owner (id, display_name, bootstrapped_at)
         VALUES ('owner', ?, ?)
         ON CONFLICT(id) DO UPDATE SET bootstrapped_at = COALESCE(auth_owner.bootstrapped_at, excluded.bootstrapped_at)`,
      )
      .run(this.opts.ownerName, ts);
  }
}

import { createHash } from 'node:crypto';
import path from 'node:path';

export interface RedactionResult<T = unknown> {
  value: T;
  redactionCount: number;
}

const SENSITIVE_KEY_RE =
  /(?:^|_|-)(token|password|passwd|secret|apikey|api_key|key|pass|credential|auth_token|private_key)(?:$|_|-)/i;

const ENV_LINE_RE =
  /^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)(\s*=\s*)(.+?)(\s*)$/;

const YAML_KV_RE =
  /^(\s*(?:-\s*)?)([A-Za-z_][A-Za-z0-9_.-]*)(\s*:\s*)(.+?)(\s*)$/;

const SAFE_EXACT_PLACEHOLDER_RE = /^«redacted:[^»]+»$/;
const SAFE_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE_DIGEST_RE = /^(?:sha256|sha512):[0-9a-f]{32,128}$/i;
const SAFE_HEX_ID_RE = /^[0-9a-f]{32,64}$/i;
const SAFE_PATH_RE = /^(?:\/[\w.\-@]+)+$/;
const SAFE_HOST_URL_RE = /^https?:\/\/[^:@\s]+(?::\d+)?(?:\/[^\s]*)?$/i;

const DENIED_FILE_PATTERNS: readonly RegExp[] = [
  /^\.env($|\.)/i,
  /\.pem$/i,
  /\.key$/i,
  /id_rsa/i,
  /id_ed25519/i,
  /cookies/i,
  /\.sqlite3?$/i,
  /\.db(-wal|-shm)?$/i,
  /^keys\.json$/i,
  /secret/i,
  /token/i,
];

function marker(type: string, raw: string): string {
  const hash = createHash('sha256').update(raw).digest('hex').slice(0, 4);
  return `«redacted:${type}:${hash}»`;
}

export function shannonEntropy(input: string): number {
  if (input.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of input) {
    counts.set(ch, (counts.get(ch) ?? 0) + 1);
  }
  let entropy = 0;
  const len = input.length;
  for (const count of counts.values()) {
    const p = count / len;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

function isSafeNonSecretToken(s: string): boolean {
  if (SAFE_EXACT_PLACEHOLDER_RE.test(s)) return true;
  if (SAFE_UUID_RE.test(s)) return true;
  if (SAFE_DIGEST_RE.test(s)) return true;
  if (SAFE_HEX_ID_RE.test(s)) return true;
  if (SAFE_PATH_RE.test(s)) return true;
  if (SAFE_HOST_URL_RE.test(s)) return true;
  return false;
}

export function isSensitiveKeyName(key: string): boolean {
  const normalized = key.trim();
  if (!normalized) return false;
  // Explicit allowlist for non-secret keys that contain "key" or "token"
  if (
    /^(?:idempotency_key|sort_key|primary_key|foreign_key|key_name|key_count|token_kind|token_id|public_key_id|cache_key)$/i.test(
      normalized,
    )
  ) {
    return false;
  }
  return (
    SENSITIVE_KEY_RE.test(normalized) ||
    /(?:TOKEN|PASSWORD|PASSWD|SECRET|APIKEY|API_KEY|_KEY|_PASS|CREDENTIAL)$/i.test(normalized)
  );
}

export function isDeniedPath(filePath: string): boolean {
  const base = path.posix.basename(filePath.replace(/\\/g, '/'));
  if (/^\.env\.example$/i.test(base) || /\.env\.[^.]+\.example$/i.test(base)) {
    return false;
  }
  if (DENIED_FILE_PATTERNS.some((re) => re.test(base))) {
    return true;
  }
  // Also deny known secret directories
  const norm = filePath.replace(/\\/g, '/').toLowerCase();
  if (norm.includes('/.ssh/') || norm.includes('/etc/homemcp/backup/')) {
    return true;
  }
  return false;
}

export class Redactor {
  private readonly exactSecrets = new Set<string>();

  public registerSecret(secret: string | undefined): void {
    if (!secret) return;
    const trimmed = secret.trim();
    if (trimmed.length >= 6) {
      this.exactSecrets.add(trimmed);
    }
  }

  public registerSecrets(secrets: Iterable<string | undefined>): void {
    for (const s of secrets) {
      this.registerSecret(s);
    }
  }

  public redactString(input: string, options?: { highEntropyContext?: boolean }): {
    text: string;
    count: number;
  } {
    if (!input) return { text: input, count: 0 };
    let text = input;
    let count = 0;

    // Layer 1: Exact registered secrets (longest first to avoid partial prefix matches)
    if (this.exactSecrets.size > 0) {
      const sorted = [...this.exactSecrets].sort((a, b) => b.length - a.length);
      for (const secret of sorted) {
        if (text.includes(secret)) {
          const m = marker('secret', secret);
          const parts = text.split(secret);
          count += parts.length - 1;
          text = parts.join(m);
        }
      }
    }

    // Layer 3a: PEM private key blocks (multi-line)
    text = text.replace(
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
      (match) => {
        count++;
        return marker('pem', match);
      },
    );

    // Layer 3b: Cloudflare tunnel CLI --token flag and base64 tunnel JSON
    text = text.replace(/(--token(?:=|\s+))(['"]?)([A-Za-z0-9_=-]{20,})\2/g, (_m, p1: string, q: string, tok: string) => {
      if (SAFE_EXACT_PLACEHOLDER_RE.test(tok)) return `${p1}${q}${tok}${q}`;
      count++;
      return `${p1}${q}${marker('cf_tunnel', tok)}${q}`;
    });
    text = text.replace(/\beyJhIjoi[A-Za-z0-9_=-]{20,}\b/g, (tok) => {
      count++;
      return marker('cf_tunnel', tok);
    });

    // Layer 3c: Authorization / Cookie headers
    text = text.replace(
      /\b(Authorization\s*:\s*(?:Bearer|Basic|Token)\s+)([^\s\r\n"']+)/gi,
      (_m, p1: string, tok: string) => {
        if (SAFE_EXACT_PLACEHOLDER_RE.test(tok)) return `${p1}${tok}`;
        count++;
        return `${p1}${marker('auth_header', tok)}`;
      },
    );
    text = text.replace(
      /\b((?:Set-)?Cookie\s*:\s*)([^\r\n]+)/gi,
      (_m, p1: string, val: string) => {
        if (SAFE_EXACT_PLACEHOLDER_RE.test(val.trim())) return `${p1}${val}`;
        count++;
        return `${p1}${marker('cookie', val)}`;
      },
    );

    // Layer 3d: URLs with embedded user:pass@host
    text = text.replace(
      /\b([a-z][a-z0-9+.-]*:\/\/)([^:\s/@]+):([^@\s/]+)@/gi,
      (_m, scheme: string, user: string, pass: string) => {
        if (SAFE_EXACT_PLACEHOLDER_RE.test(pass)) return `${scheme}${user}:${pass}@`;
        count++;
        return `${scheme}${user}:${marker('url_auth', `${user}:${pass}`)}@`;
      },
    );

    // Layer 3e: Well-known token prefixes and JWTs
    text = text.replace(
      /\b(ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|gsk_[A-Za-z0-9]{20,}|sk-or-[A-Za-z0-9-]{20,}|AKIA[0-9A-Z]{16}|tk_[a-z0-9]{16,}|hmp_[A-Za-z0-9_-]{16,})\b/g,
      (tok) => {
        count++;
        return marker('token', tok);
      },
    );
    text = text.replace(
      /\bsk-[A-Za-z0-9_-]{20,}\b/g,
      (tok) => {
        count++;
        return marker('token', tok);
      },
    );
    text = text.replace(
      /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
      (tok) => {
        count++;
        return marker('jwt', tok);
      },
    );

    // Layer 2 & Layer 4: Line-by-line KEY=VAL / YAML KEY: VAL & high-entropy context
    const lines = text.split('\n');
    let lineModified = false;
    const processedLines = lines.map((line) => {
      const envMatch = ENV_LINE_RE.exec(line);
      if (envMatch) {
        const [, pre, key, eq, rawVal, post] = envMatch;
        const val = rawVal?.trim() ?? '';
        if (
          key &&
          isSensitiveKeyName(key) &&
          val &&
          !SAFE_EXACT_PLACEHOLDER_RE.test(val) &&
          !/^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(val)
        ) {
          count++;
          lineModified = true;
          return `${pre ?? ''}${key}${eq ?? '='}${marker('env', val)}${post ?? ''}`;
        }
        if (options?.highEntropyContext && val.length >= 24 && !isSafeNonSecretToken(val)) {
          const clean = val.replace(/^['"]|['"]$/g, '');
          if (clean.length >= 24 && !isSafeNonSecretToken(clean) && shannonEntropy(clean) > 4.0) {
            count++;
            lineModified = true;
            return `${pre ?? ''}${key ?? ''}${eq ?? '='}${marker('entropy', clean)}${post ?? ''}`;
          }
        }
      }

      const yamlMatch = YAML_KV_RE.exec(line);
      if (yamlMatch) {
        const [, pre, key, colon, rawVal, post] = yamlMatch;
        const val = rawVal?.trim() ?? '';
        if (
          key &&
          isSensitiveKeyName(key) &&
          val &&
          !val.startsWith('{') &&
          !val.startsWith('[') &&
          !SAFE_EXACT_PLACEHOLDER_RE.test(val) &&
          !/^['"]?\$\{[A-Za-z_][A-Za-z0-9_]*\}['"]?$/.test(val) &&
          !/^env:[A-Za-z_][A-Za-z0-9_]*$/.test(val)
        ) {
          count++;
          lineModified = true;
          return `${pre ?? ''}${key}${colon ?? ': '}${marker('key', val)}${post ?? ''}`;
        }
      }

      if (options?.highEntropyContext) {
        const tokens = line.split(/(\s+)/);
        let tokChanged = false;
        const nextTokens = tokens.map((tok) => {
          if (!tok || /^\s+$/.test(tok)) return tok;
          const clean = tok.replace(/^['"]|['"]$/g, '');
          if (clean.length >= 24 && !isSafeNonSecretToken(clean) && shannonEntropy(clean) > 4.0) {
            count++;
            tokChanged = true;
            lineModified = true;
            return marker('entropy', clean);
          }
          return tok;
        });
        if (tokChanged) return nextTokens.join('');
      }

      return line;
    });

    if (lineModified) {
      text = processedLines.join('\n');
    }

    return { text, count };
  }

  public redactValue<T>(
    value: T,
    options?: { highEntropyContext?: boolean },
  ): RedactionResult<T> {
    let totalCount = 0;
    const seen = new WeakSet<object>();

    const walk = (node: unknown, keyHint?: string, highEntropy = false): unknown => {
      if (node === null || node === undefined) return node;

      if (typeof node === 'string') {
        if (
          keyHint &&
          isSensitiveKeyName(keyHint) &&
          node.length > 0 &&
          !SAFE_EXACT_PLACEHOLDER_RE.test(node) &&
          !/^env:[A-Za-z_][A-Za-z0-9_]*$/.test(node) &&
          !/^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(node)
        ) {
          totalCount++;
          return marker('field', node);
        }
        const res = this.redactString(node, {
          highEntropyContext: highEntropy || (options?.highEntropyContext ?? false),
        });
        totalCount += res.count;
        return res.text;
      }

      if (typeof node !== 'object') return node;

      if (node instanceof Error) {
        if (seen.has(node)) return '[Circular Error]';
        seen.add(node);
        const msg = walk(node.message, undefined, highEntropy) as string;
        const out: Record<string, unknown> = {
          name: node.name,
          message: msg,
        };
        if (node.stack) {
          out['stack'] = walk(node.stack, undefined, highEntropy);
        }
        return out;
      }

      if (seen.has(node)) return '[Circular]';
      seen.add(node);

      if (Array.isArray(node)) {
        return node.map((item) => walk(item, undefined, highEntropy));
      }

      const obj = node as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(obj)) {
        const nextHighEntropy =
          highEntropy || /^(?:args|cmd|command|env|environment|argv)$/i.test(k);
        out[k] = walk(v, k, nextHighEntropy);
      }
      return out;
    };

    const redacted = walk(value) as T;
    return { value: redacted, redactionCount: totalCount };
  }
}

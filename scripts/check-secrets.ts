import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const REAL_SECRET_PATTERNS: ReadonlyArray<{ name: string; regex: RegExp }> = [
  { name: 'OpenRouter key', regex: /\bsk-or-v1-[A-Za-z0-9]{20,}\b/ },
  { name: 'Groq key', regex: /\bgsk_[A-Za-z0-9]{20,}\b/ },
  { name: 'GitHub PAT', regex: /\b(?:ghp|gho|ghu)_[A-Za-z0-9]{20,}\b/ },
  { name: 'GitHub fine-grained PAT', regex: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/ },
  { name: 'AWS access key', regex: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'Slack token', regex: /\bxox[baprs]-[A-Za-z0-9-]{16,}\b/ },
  { name: 'Private key PEM', regex: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: 'homemcp PAT secret', regex: /\bhmp_[A-Za-z0-9_-]{32,}\b/ },
  { name: 'Cloudflare API token', regex: /\b(?:cfut|cfat)_[A-Za-z0-9_-]{20,}\b/ },
];

// Hash-encoded personal-infrastructure denylist (so no private identifiers exist in source)
const DENIED_TOKEN_HASHES = new Set([
  'c5927976865076cf',
  '3a5ccd9cf159baae',
  'c58b232f0aa1e251',
  'c3da830da769bd8f',
]);

function containsDeniedPersonalToken(line: string): boolean {
  const lower = line.toLowerCase();
  const tokens = lower.match(/[a-z0-9-]+(?:\.[0-9]+){0,3}/g) ?? [];
  for (const tok of tokens) {
    if (tok.length < 6) continue;
    const h = createHash('sha256').update(tok).digest('hex').slice(0, 16);
    if (DENIED_TOKEN_HASHES.has(h)) return true;
    // Also check composite words (e.g., concatenated handle+surname)
    for (let i = 0; i <= tok.length - 6; i++) {
      for (const len of [6, 8, 10, 11]) {
        if (i + len <= tok.length) {
          const sub = tok.slice(i, i + len);
          const sh = createHash('sha256').update(sub).digest('hex').slice(0, 16);
          if (DENIED_TOKEN_HASHES.has(sh)) return true;
        }
      }
    }
  }
  return false;
}

function main(): void {
  const tracked = execFileSync('git', ['ls-files'], { encoding: 'utf8' })
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);

  const findings: string[] = [];

  for (const rel of tracked) {
    const isSyntheticTestFile =
      rel.includes('/test/') || rel === 'evals/tasks.yaml' || rel === '.gitleaks.toml';
    let content = '';
    try {
      content = readFileSync(path.resolve(process.cwd(), rel), 'utf8');
    } catch {
      continue;
    }

    const lines = content.split(/\r?\n/);
    lines.forEach((line, idx) => {
      if (containsDeniedPersonalToken(line)) {
        findings.push(`${rel}:${idx + 1} matches personal-data denylist`);
      }
      if (!isSyntheticTestFile) {
        for (const p of REAL_SECRET_PATTERNS) {
          if (p.regex.test(line)) {
            findings.push(`${rel}:${idx + 1} matches secret pattern "${p.name}"`);
          }
        }
      }
    });
  }

  if (findings.length > 0) {
    process.stderr.write(
      `Secret/privacy scan FAILED (${findings.length} finding(s)):\n${findings.join('\n')}\n`,
    );
    process.exit(1);
  }
  process.stdout.write(
    `Secret/privacy scan passed across ${tracked.length} tracked files (0 findings).\n`,
  );
}

main();

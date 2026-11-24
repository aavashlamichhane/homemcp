import { execa } from 'execa';
import { HomemcpError } from '@homemcp/core';

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface CommandRunner {
  run(
    binary: string,
    args: readonly string[],
    options?: {
      timeoutMs?: number | undefined;
      cwd?: string | undefined;
      allowNonZero?: boolean | undefined;
    },
  ): Promise<ExecResult>;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_BUFFER_BYTES = 2_000_000;

export class ExecaCommandRunner implements CommandRunner {
  private readonly allowedBinaries: ReadonlySet<string>;

  public constructor(allowedBinaries: Iterable<string>) {
    this.allowedBinaries = new Set(allowedBinaries);
  }

  public async run(
    binary: string,
    args: readonly string[],
    options?: {
      timeoutMs?: number | undefined;
      cwd?: string | undefined;
      allowNonZero?: boolean | undefined;
    },
  ): Promise<ExecResult> {
    if (!binary.startsWith('/') || !this.allowedBinaries.has(binary)) {
      throw new HomemcpError('POLICY_DENIED', `Binary not in allowlist: ${binary}`);
    }

    try {
      const res = await execa(binary, [...args], {
        shell: false,
        timeout: options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER_BYTES,
        ...(options?.cwd !== undefined ? { cwd: options.cwd } : {}),
        reject: false,
        env: {
          PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
          LANG: 'C.UTF-8',
        },
      });
      if (res.timedOut) {
        throw new HomemcpError('TIMEOUT', `Command timed out: ${binary}`);
      }
      if (res.isMaxBuffer) {
        throw new HomemcpError('INTERNAL_ERROR', `Command output exceeded 2MB cap: ${binary}`);
      }
      const exitCode = res.exitCode ?? 1;
      if (!options?.allowNonZero && exitCode !== 0) {
        throw new HomemcpError('INTERNAL_ERROR', `Command ${binary} failed with exit ${exitCode}`, {
          details: { stderr: res.stderr.slice(0, 500) },
        });
      }
      return {
        stdout: res.stdout,
        stderr: res.stderr,
        exitCode,
      };
    } catch (err) {
      if (err instanceof HomemcpError) throw err;
      throw new HomemcpError(
        'INTERNAL_ERROR',
        `Failed to execute ${binary}: ${err instanceof Error ? err.message : 'unknown error'}`,
        { cause: err },
      );
    }
  }
}

export const P1_ALLOWED_BINARIES = [
  '/usr/bin/journalctl',
  '/usr/bin/systemctl',
  '/usr/bin/sadf',
  '/usr/bin/df',
  '/usr/bin/ps',
  '/usr/bin/ip',
  '/usr/bin/ss',
  '/usr/bin/apt-get',
  '/usr/bin/tailscale',
  '/bin/df',
  '/bin/ps',
] as const;

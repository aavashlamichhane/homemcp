import type { ErrorCode } from './types.js';

export class HomemcpError extends Error {
  public readonly code: ErrorCode;
  public readonly hint: string | undefined;
  public readonly details: Record<string, unknown> | undefined;

  public constructor(
    code: ErrorCode,
    message: string,
    options?: {
      hint?: string | undefined;
      details?: Record<string, unknown> | undefined;
      cause?: unknown;
    },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'HomemcpError';
    this.code = code;
    this.hint = options?.hint;
    this.details = options?.details;
  }

  public toMcpToolResult(): {
    isError: true;
    content: Array<{ type: 'text'; text: string }>;
    structuredContent: {
      error: {
        code: ErrorCode;
        message: string;
        hint?: string | undefined;
      };
    };
  } {
    const payload = {
      error: {
        code: this.code,
        message: this.message,
        ...(this.hint ? { hint: this.hint } : {}),
      },
    };
    const text = this.hint
      ? `[${this.code}] ${this.message}\nHint: ${this.hint}`
      : `[${this.code}] ${this.message}`;
    return {
      isError: true,
      content: [{ type: 'text', text }],
      structuredContent: payload,
    };
  }
}

export class ConfigError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

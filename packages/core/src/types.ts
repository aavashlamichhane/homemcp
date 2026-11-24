export type Tier = 'T0' | 'T1' | 'T2' | 'T3';

export type Scope =
  | 'homemcp:read'
  | 'homemcp:operate'
  | 'homemcp:admin'
  | 'homemcp:audit';

export const ALL_SCOPES: readonly Scope[] = [
  'homemcp:read',
  'homemcp:operate',
  'homemcp:admin',
  'homemcp:audit',
] as const;

export const TOOLSET_NAMES = [
  'core',
  'system',
  'docker',
  'network',
  'apps',
  'backup',
  'vaultwarden',
  'music',
  'naviload',
  'media',
  'downloads',
  'alerts',
  'stacks',
  'files',
  'auth',
] as const;

export type ToolsetName = (typeof TOOLSET_NAMES)[number];

export interface ToolAnnotations {
  title: string;
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

export type ErrorCode =
  | 'NOT_FOUND'
  | 'POLICY_DENIED'
  | 'CONFIRMATION_REQUIRED'
  | 'UPSTREAM_UNAVAILABLE'
  | 'UPSTREAM_AUTH'
  | 'CONFLICT'
  | 'TIMEOUT'
  | 'INVALID_ARGUMENT'
  | 'RATE_LIMITED'
  | 'INTERNAL_ERROR';

export interface AgentRpcRequest {
  verb: string;
  params: Record<string, unknown>;
}

export interface AgentRpcResponse<T = unknown> {
  ok: boolean;
  result?: T;
  error?: {
    code: ErrorCode;
    message: string;
    hint?: string | undefined;
  };
}

export interface AuthContext {
  subject: string;
  clientId: string;
  tokenKind: 'oauth' | 'pat' | 'stdio';
  tokenId: string;
  scopes: readonly string[];
  allowedToolsets?: readonly ToolsetName[] | undefined;
  authTime?: number | undefined;
}

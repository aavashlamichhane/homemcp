import { randomUUID } from 'node:crypto';
import type { McpServer, ServerContext } from '@modelcontextprotocol/server';
import { requireScopes, ResourceTemplate } from '@modelcontextprotocol/server';
import type * as z from 'zod/v4';
import {
  buildToolResult,
  hasRequiredScope,
  HomemcpError,
  requiredScopeForTool,
  type AuthContext,
  type Redactor,
  type Scope,
  type Tier,
  type ToolAnnotations,
  type ToolsetName,
} from '@homemcp/core';
import type { HomemcpDb } from '../db/database.js';

export interface ToolRuntimeContext {
  auth: AuthContext;
  mcpCtx: ServerContext;
}

export interface RegisteredToolSpec<
  TIn extends z.ZodType | undefined = z.ZodType | undefined,
  TOut extends z.ZodType = z.ZodType,
> {
  name: string;
  toolset: ToolsetName;
  tier: Tier;
  scope?: Scope | undefined;
  description: string;
  annotations: ToolAnnotations;
  inputSchema?: TIn;
  outputSchema: TOut;
  handler: (
    args: TIn extends z.ZodType ? z.infer<TIn> : undefined,
    ctx: ToolRuntimeContext,
  ) => Promise<{
    summary: string;
    structured: z.infer<TOut>;
    planId?: string | undefined;
    confirmationId?: string | undefined;
    jobId?: string | undefined;
    resources?: string[] | undefined;
  }>;
}

export interface RegisteredResourceSpec {
  name: string;
  uri?: string | undefined;
  template?: string | undefined;
  list?: (() => Promise<{ resources: Array<{ uri: string; name: string }> }>) | undefined;
  title: string;
  description: string;
  mimeType: string;
  scope?: Scope | undefined;
  handler: (
    uri: URL,
    vars: Record<string, string>,
    auth: AuthContext,
  ) => Promise<string>;
}

export interface RegisteredPromptSpec {
  name: string;
  title: string;
  description: string;
  argsSchema?: z.ZodType | undefined;
  handler: (args: Record<string, unknown>) => Promise<{
    messages: Array<{ role: 'user'; content: { type: 'text'; text: string } }>;
  }>;
}

export class HomemcpRegistry {
  private readonly tools = new Map<string, RegisteredToolSpec<z.ZodType | undefined, z.ZodType>>();
  private readonly resources: RegisteredResourceSpec[] = [];
  private readonly prompts: RegisteredPromptSpec[] = [];

  public registerTool<TIn extends z.ZodType | undefined, TOut extends z.ZodType>(
    spec: RegisteredToolSpec<TIn, TOut>,
  ): void {
    if (this.tools.has(spec.name)) {
      throw new Error(`Duplicate tool registration: ${spec.name}`);
    }
    if (!spec.annotations?.title) {
      throw new Error(`Tool ${spec.name} missing required annotations.title`);
    }
    if (!spec.outputSchema) {
      throw new Error(`Tool ${spec.name} missing required outputSchema`);
    }
    if (!spec.tier || !spec.toolset) {
      throw new Error(`Tool ${spec.name} missing required tier or toolset`);
    }
    this.tools.set(spec.name, spec);
  }

  public registerResource(spec: RegisteredResourceSpec): void {
    this.resources.push(spec);
  }

  public registerPrompt(spec: RegisteredPromptSpec): void {
    this.prompts.push(spec);
  }

  public listTools(): Array<RegisteredToolSpec<z.ZodType | undefined, z.ZodType>> {
    return [...this.tools.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  public listResources(): readonly RegisteredResourceSpec[] {
    return this.resources;
  }

  public listPrompts(): readonly RegisteredPromptSpec[] {
    return this.prompts;
  }

  public attachToServer(
    server: McpServer,
    deps: {
      db: HomemcpDb;
      redactor: Redactor;
      activeToolsets: readonly ToolsetName[];
      defaultAuth: AuthContext;
    },
  ): void {
    const activeSet = new Set(deps.activeToolsets);

    for (const tool of this.tools.values()) {
      if (!activeSet.has(tool.toolset)) continue;
      const reqScope = requiredScopeForTool(tool.tier, tool.scope);
      if (!hasRequiredScope(deps.defaultAuth.scopes, reqScope)) continue;

      const config = {
        title: tool.annotations.title,
        description: tool.description,
        annotations: tool.annotations,
        ...(tool.inputSchema ? { inputSchema: tool.inputSchema } : {}),
        outputSchema: tool.outputSchema,
        scopeChallenge: requireScopes(reqScope),
      };

      const execute = async (args: unknown, mcpCtx: ServerContext) => {
        const start = Date.now();
        const extraSub = mcpCtx.http?.authInfo?.extra?.['subject'];
        const extraTid = mcpCtx.http?.authInfo?.extra?.['tokenId'];
        const auth: AuthContext = mcpCtx.http?.authInfo
          ? {
              subject: typeof extraSub === 'string' ? extraSub : 'owner',
              clientId: mcpCtx.http.authInfo.clientId,
              tokenKind:
                (mcpCtx.http.authInfo.extra?.['tokenKind'] as AuthContext['tokenKind']) ?? 'oauth',
              tokenId: typeof extraTid === 'string' ? extraTid : 'unknown',
              scopes: mcpCtx.http.authInfo.scopes,
              authTime:
                typeof mcpCtx.http.authInfo.extra?.['authTime'] === 'number'
                  ? mcpCtx.http.authInfo.extra['authTime']
                  : undefined,
            }
          : deps.defaultAuth;

        const redactedArgs = deps.redactor.redactValue(args ?? {}).value;
        let status = 'ok';
        let errorCode: string | null = null;
        let planId: string | null = null;
        let confirmationId: string | null = null;
        let jobId: string | null = null;
        let resourcesJson: string | null = null;

        try {
          if (!hasRequiredScope(auth.scopes, reqScope)) {
            throw new HomemcpError(
              'POLICY_DENIED',
              `Missing required scope: ${reqScope}`,
            );
          }

          const out = await tool.handler(args, { auth, mcpCtx });
          planId = out.planId ?? null;
          confirmationId = out.confirmationId ?? null;
          jobId = out.jobId ?? null;
          resourcesJson = out.resources ? JSON.stringify(out.resources) : null;

          const parsedOut = tool.outputSchema.safeParse(out.structured);
          if (!parsedOut.success) {
            throw new HomemcpError(
              'INTERNAL_ERROR',
              `Tool ${tool.name} output validation failed: ${parsedOut.error.issues[0]?.message ?? 'invalid'}`,
            );
          }

          const rawResult = buildToolResult(
            out.summary,
            parsedOut.data as Record<string, unknown>,
          );
          const redacted = deps.redactor.redactValue(rawResult).value;
          return redacted;
        } catch (err) {
          status = 'error';
          const hErr =
            err instanceof HomemcpError
              ? err
              : new HomemcpError(
                  'INTERNAL_ERROR',
                  err instanceof Error ? err.message : String(err),
                );
          errorCode = hErr.code;
          const errPayload = deps.redactor.redactValue(hErr.toMcpToolResult()).value;
          return errPayload;
        } finally {
          deps.db.insertAudit({
            id: randomUUID(),
            ts: new Date().toISOString(),
            subject: auth.subject,
            client_id: auth.clientId,
            token_kind: auth.tokenKind,
            token_id: auth.tokenId,
            tool: tool.name,
            args_redacted: JSON.stringify(redactedArgs),
            tier: tool.tier,
            plan_id: planId,
            confirmation_id: confirmationId,
            status,
            error_code: errorCode,
            duration_ms: Date.now() - start,
            job_id: jobId,
            resources: resourcesJson,
          });
        }
      };

      server.registerTool(
        tool.name,
        config as unknown as Parameters<McpServer['registerTool']>[1],
        ((a: unknown, b?: unknown) =>
          tool.inputSchema
            ? execute(a, b as ServerContext)
            : execute(undefined, a as ServerContext)) as unknown as Parameters<
          McpServer['registerTool']
        >[2],
      );
    }

    for (const res of this.resources) {
      const reqScope = res.scope ?? 'homemcp:read';
      if (!hasRequiredScope(deps.defaultAuth.scopes, reqScope)) continue;

      if (res.template) {
        const tmpl = new ResourceTemplate(res.template, {
          list: res.list
            ? async () => {
                const listed = await res.list!();
                return { resources: listed.resources };
              }
            : undefined,
        });
        server.registerResource(
          res.name,
          tmpl,
          {
            title: res.title,
            description: res.description,
            mimeType: res.mimeType,
            scopeChallenge: requireScopes(reqScope),
          },
          async (uri, vars, mcpCtx) => {
            const strVars: Record<string, string> = {};
            for (const [k, v] of Object.entries(vars)) {
              strVars[k] = Array.isArray(v) ? v.join('/') : String(v);
            }
            const text = await res.handler(uri, strVars, deps.defaultAuth);
            void mcpCtx;
            const redacted = deps.redactor.redactString(text).text;
            return { contents: [{ uri: uri.href, mimeType: res.mimeType, text: redacted }] };
          },
        );
      } else if (res.uri) {
        server.registerResource(
          res.name,
          res.uri,
          {
            title: res.title,
            description: res.description,
            mimeType: res.mimeType,
            scopeChallenge: requireScopes(reqScope),
          },
          async (uri) => {
            const text = await res.handler(uri, {}, deps.defaultAuth);
            const redacted = deps.redactor.redactString(text).text;
            return { contents: [{ uri: uri.href, mimeType: res.mimeType, text: redacted }] };
          },
        );
      }
    }

    for (const pr of this.prompts) {
      server.registerPrompt(
        pr.name,
        {
          title: pr.title,
          description: pr.description,
          ...(pr.argsSchema ? { argsSchema: pr.argsSchema as never } : {}),
        },
        async (a: unknown) => {
          const args = pr.argsSchema && typeof a === 'object' && a ? (a as Record<string, unknown>) : {};
          const res = await pr.handler(args);
          return deps.redactor.redactValue(res).value;
        },
      );
    }
  }
}

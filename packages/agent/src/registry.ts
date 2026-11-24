import type * as z from 'zod/v4';
import { HomemcpError } from '@homemcp/core';

export interface VerbDefinition<TIn extends z.ZodType, TOut extends z.ZodType> {
  name: string;
  inputSchema: TIn;
  outputSchema: TOut;
  handler: (input: z.infer<TIn>) => Promise<z.infer<TOut>>;
}

export class VerbRegistry {
  private readonly verbs = new Map<string, VerbDefinition<z.ZodType, z.ZodType>>();

  public register<TIn extends z.ZodType, TOut extends z.ZodType>(
    def: VerbDefinition<TIn, TOut>,
  ): void {
    if (this.verbs.has(def.name)) {
      throw new Error(`Duplicate agent verb: ${def.name}`);
    }
    this.verbs.set(def.name, def);
  }

  public listVerbs(): string[] {
    return [...this.verbs.keys()].sort();
  }

  public async dispatch(verbName: string, rawParams: unknown): Promise<unknown> {
    const def = this.verbs.get(verbName);
    if (!def) {
      throw new HomemcpError('NOT_FOUND', `Unknown agent verb: ${verbName}`);
    }

    const parsedIn = def.inputSchema.safeParse(rawParams ?? {});
    if (!parsedIn.success) {
      const msg = parsedIn.error.issues
        .map((i) => `${i.path.join('.') || '<params>'}: ${i.message}`)
        .join('; ');
      throw new HomemcpError('INVALID_ARGUMENT', `Invalid params for ${verbName}: ${msg}`);
    }

    const result = await def.handler(parsedIn.data);
    const parsedOut = def.outputSchema.safeParse(result);
    if (!parsedOut.success) {
      throw new HomemcpError(
        'INTERNAL_ERROR',
        `Verb ${verbName} produced invalid output schema`,
      );
    }
    return parsedOut.data;
  }
}

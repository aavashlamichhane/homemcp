export interface SagaStep {
  name: string;
  run: () => Promise<unknown>;
  undo?: (() => Promise<void>) | undefined;
}

export interface SagaResult {
  ok: boolean;
  completed_steps: string[];
  failed_step?: string | undefined;
  error?: string | undefined;
  rolled_back_steps: string[];
  rollback_errors: Array<{ step: string; error: string }>;
  step_outputs: Record<string, unknown>;
}

export class SagaRunner {
  public async run(steps: readonly SagaStep[]): Promise<SagaResult> {
    const completed: Array<{ name: string; undo?: (() => Promise<void>) | undefined }> = [];
    const outputs: Record<string, unknown> = {};

    for (const step of steps) {
      try {
        const out = await step.run();
        outputs[step.name] = out;
        completed.push({ name: step.name, undo: step.undo });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        const rolledBack: string[] = [];
        const rollbackErrors: Array<{ step: string; error: string }> = [];

        // Reverse-order undo of completed steps
        for (let i = completed.length - 1; i >= 0; i--) {
          const item = completed[i]!;
          if (!item.undo) continue;
          try {
            await item.undo();
            rolledBack.push(item.name);
          } catch (undoErr) {
            rollbackErrors.push({
              step: item.name,
              error: undoErr instanceof Error ? undoErr.message : String(undoErr),
            });
          }
        }

        return {
          ok: false,
          completed_steps: completed.map((c) => c.name),
          failed_step: step.name,
          error: errorMsg,
          rolled_back_steps: rolledBack,
          rollback_errors: rollbackErrors,
          step_outputs: outputs,
        };
      }
    }

    return {
      ok: true,
      completed_steps: completed.map((c) => c.name),
      rolled_back_steps: [],
      rollback_errors: [],
      step_outputs: outputs,
    };
  }
}

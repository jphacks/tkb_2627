import { randomUUID } from 'node:crypto';
import type { GenerationInput } from '@tkb/contracts';
import { samplePlanBlueprint } from '@tkb/fixtures';
import type { Runner, RunnerResult } from './runner.ts';

export type FakeFailureMode = 'invalid_json' | 'timeout' | 'exit_nonzero' | 'no_structured_output';

/** Never spawns a process. Used until A01 confirms the real CLI terms. */
export class FakeRunner implements Runner {
  constructor(private readonly opts: { failure?: FakeFailureMode } = {}) {}

  async run(_input: GenerationInput, signal: AbortSignal): Promise<RunnerResult> {
    if (signal.aborted) throw new DOMException('aborted', 'AbortError');
    const started = Date.now();
    const requestId = randomUUID();
    const done = (r: Omit<RunnerResult, 'durationMs'>): RunnerResult => ({ ...r, durationMs: Date.now() - started });
    switch (this.opts.failure) {
      case 'invalid_json':
        return done({ exitCode: 0, envelope: { type: 'result', structured_output: '{not json' } });
      case 'no_structured_output':
        return done({ exitCode: 0, envelope: { type: 'result', result: 'text only' } });
      case 'exit_nonzero':
        return done({
          exitCode: 1,
          envelope: null,
          error: { code: 'CLI_EXIT', message: 'The generator exited with an error.', retryable: true, requestId },
        });
      case 'timeout':
        return new Promise<RunnerResult>((_, reject) => {
          signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
        });
      default:
        return done({
          exitCode: 0,
          envelope: { type: 'result', is_error: false, structured_output: samplePlanBlueprint },
        });
    }
  }
}

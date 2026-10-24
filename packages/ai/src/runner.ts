import type { GenerationInput } from '@tkb/contracts';

/** model/code-model.json SafeError. Never contains secrets, executable paths or raw stderr. */
export interface SafeError {
  code: 'CLI_NOT_AUTHENTICATED' | 'CLI_LIMIT' | 'CLI_TIMEOUT' | 'CLI_EXIT' | 'INVALID_OUTPUT' | 'CANCELLED';
  message: string;
  retryable: boolean;
  requestId: string;
}

/** Run metadata that carries no content (A04 metrics). Null where the CLI did not report it. */
export interface RunnerMeta {
  model: string | null;
  numTurns: number | null;
  durationApiMs: number | null;
}

export interface RunnerResult {
  exitCode: number;
  /** Raw CLI envelope. Not trusted until parseBlueprint succeeds. */
  envelope: unknown;
  durationMs: number;
  error?: SafeError;
  meta?: RunnerMeta;
}

export interface Runner {
  run(input: GenerationInput, signal: AbortSignal): Promise<RunnerResult>;
}

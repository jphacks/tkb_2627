import type { Capabilities } from '@tkb/contracts';
import { ClaudeCodeRunner, type ClaudeCodeRunnerOptions, FakeRunner, checkClaudeCli, type PreflightResult, type Runner } from '@tkb/ai';
import type { PersonalConfig } from './config.ts';

/**
 * W2: the ONLY place a ClaudeCodeRunner is constructed (a static guard test enforces this).
 * The real runner is returned only when ALL hold: ALLOW_CLAUDE_EXECUTION=true, CLAUDE_TERMS_ACK=true
 * ("A01 ack on #25 by M4 and M1"), PERSONAL_OWNER_USER_ID set, and the auth preflight (claude.ai login, no billing env) is ok.
 * Otherwise a FakeRunner is returned together with the K22 reason.
 */
type AiUnavailableReason = NonNullable<Capabilities['aiGeneration']['reason']>;

export interface RunnerStatus {
  available: boolean;
  runner: 'fake' | 'claude-code';
  reason: AiUnavailableReason | null;
}

export interface RunnerFactoryDeps {
  /** Default: checkClaudeCli. Injected in tests (never the real CLI). */
  preflight?: (o: { bin: string }) => Promise<PreflightResult>;
  env?: NodeJS.ProcessEnv;
  spawnImpl?: ClaudeCodeRunnerOptions['spawnImpl'];
  tmpRoot?: string;
  now?: () => number;
}

export interface CreatedRunner {
  runner: Runner;
  /** Last known status (startup preflight, refreshed at most once per 60s by real runs). */
  status(): RunnerStatus;
}

const TTL_MS = 60_000;
const FAKE_OFF = (reason: AiUnavailableReason): RunnerStatus => ({ available: false, runner: 'fake', reason });

export async function createRunner(config: PersonalConfig, deps: RunnerFactoryDeps = {}): Promise<CreatedRunner> {
  const fake = (reason: AiUnavailableReason): CreatedRunner => ({ runner: new FakeRunner(), status: () => FAKE_OFF(reason) });
  if (config.allowClaudeExecution !== true) return fake('CLAUDE_EXECUTION_DISABLED');
  if (config.claudeTermsAck !== true || !config.ownerUserId) return fake('TERMS_NOT_CONFIRMED');

  const now = deps.now ?? Date.now;
  const run = (): Promise<PreflightResult> =>
    deps.preflight
      ? deps.preflight({ bin: config.claudeBin })
      : checkClaudeCli({ bin: config.claudeBin, env: deps.env, spawnImpl: deps.spawnImpl, ...(deps.tmpRoot ? { tmpRoot: deps.tmpRoot } : {}) });
  const safeRun = (): Promise<PreflightResult> => run().catch((): PreflightResult => ({ found: true, reason: 'CLI_NOT_AUTHENTICATED' }));

  let last = await safeRun();
  let at = now();
  const reasonOf = (r: PreflightResult): AiUnavailableReason | null =>
    r.reason === null ? null : r.reason === 'CLI_NOT_FOUND' ? 'CLI_NOT_FOUND' : r.reason === 'TERMS_NOT_CONFIRMED' ? 'TERMS_NOT_CONFIRMED' : 'CLI_NOT_AUTHENTICATED';
  if (last.reason !== null) return fake(reasonOf(last)!);

  let pending: Promise<PreflightResult> | null = null;
  const cached = async (): Promise<PreflightResult> => {
    if (now() - at <= TTL_MS) return last;
    pending ??= safeRun().then(r => {
      last = r;
      at = now();
      pending = null;
      return r;
    });
    return pending;
  };

  let runner: Runner;
  try {
    runner = new ClaudeCodeRunner({
      bin: config.claudeBin,
      model: config.claudeModel,
      timeoutMs: config.cliTimeoutMs,
      preflight: cached,
      ...(deps.env ? { env: deps.env } : {}),
      ...(deps.spawnImpl ? { spawnImpl: deps.spawnImpl } : {}),
      ...(deps.tmpRoot ? { tmpRoot: deps.tmpRoot } : {}),
    });
  } catch {
    return fake('CLI_NOT_FOUND'); // invalid CLAUDE_BIN / CLAUDE_MODEL
  }
  return {
    runner,
    status: () =>
      last.reason === null ? { available: true, runner: 'claude-code', reason: null } : { available: false, runner: 'claude-code', reason: reasonOf(last) },
  };
}

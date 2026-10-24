/** Content-free job metrics (A04). Only these keys can ever be printed; no place names, prompts or model output. */
export type StageInfo = Record<string, string | number | boolean | string[]>;

export interface JobMetrics {
  state: string;
  errorCode: string | null;
  collectMs: number | null;
  generateMs: number | null;
  buildMs: number | null;
  saveMs: number | null;
  totalMs: number;
  model: string | null;
  numTurns: number | null;
  /** From the pipeline stages, e.g. dataMode, sources, candidates, states. */
  info: StageInfo;
}

const KEYS: (keyof JobMetrics)[] = ['state', 'errorCode', 'collectMs', 'generateMs', 'buildMs', 'saveMs', 'totalMs', 'model', 'numTurns', 'info'];
const INFO_KEYS = new Set(['dataMode', 'sources', 'candidates', 'states', 'places', 'legs']);

/** One JSON line with the allowlisted keys only. */
export function metricsLine(m: JobMetrics): string {
  const out: Record<string, unknown> = {};
  for (const k of KEYS) if (k !== 'info') out[k] = m[k];
  out.info = Object.fromEntries(Object.entries(m.info).filter(([k]) => INFO_KEYS.has(k)));
  return JSON.stringify(out);
}

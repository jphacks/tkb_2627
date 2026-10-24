// T01 shared helpers (not a test file): schema-checked response assertions for both HTTP surfaces.
import { expect } from 'vitest';
import type { z } from 'zod';
import { ApiError, ERROR_HTTP_STATUS, type ErrorCode } from '@tkb/contracts';

export interface Res {
  statusCode: number;
  headers: Record<string, unknown>;
  body: string;
  json: () => unknown;
}

/** Status must match and the body must parse with the contract schema. Returns the parsed body. */
export function expectOk<S extends z.ZodType>(label: string, res: Res, status: number, schema: S): z.infer<S> {
  expect(res.statusCode, `${label}: status (body ${res.body.slice(0, 200)})`).toBe(status);
  const r = schema.safeParse(res.json());
  expect(r.success, `${label}: schema ${r.success ? '' : JSON.stringify(r.error.issues.slice(0, 3))}`).toBe(true);
  const data = (r as { data: z.infer<S> }).data;
  // Unknown keys are stripped by non-strict schemas; a raw key the schema does not know is a drift (new field not in the contract).
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    expect(Object.keys(res.json() as object).sort(), `${label}: top-level keys differ between response and schema`).toEqual(Object.keys(data).sort());
  }
  return data;
}

/**
 * Every error response is a K23 ApiError, its HTTP status is ERROR_HTTP_STATUS[code], the requestId equals the
 * x-request-id header, and the body carries nothing but the contract keys.
 */
export function expectErr(label: string, res: Res, code: ErrorCode): ApiError {
  const parsed = ApiError.safeParse(res.json());
  expect(parsed.success, `${label}: not an ApiError: ${res.body.slice(0, 200)}`).toBe(true);
  const e = (parsed as { data: ApiError }).data;
  expect(e.code, `${label}: code`).toBe(code);
  expect(res.statusCode, `${label}: status`).toBe(ERROR_HTTP_STATUS[code]);
  expect(e.requestId, `${label}: requestId`).toBe(res.headers['x-request-id']);
  expect(Object.keys(res.json() as object).filter(k => !['code', 'message', 'retryable', 'requestId', 'details'].includes(k)), `${label}: extra keys`).toEqual([]);
  return e;
}

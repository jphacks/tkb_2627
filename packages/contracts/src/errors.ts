import { z } from 'zod';

/** K23: shared error codes. Responses must not reveal whether another user's resource exists. */
export const ErrorCode = z.enum([
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'REVISION_CONFLICT',
  'IDEMPOTENCY_CONFLICT',
  'ALREADY_COMMITTED',
  'EXPIRED',
  'VALIDATION_FAILED',
  'CONSTRAINT_UNSATISFIED',
  'RATE_LIMITED',
  'QUEUE_FULL',
  'UNAVAILABLE',
  'AI_UNAVAILABLE',
  'CLI_NOT_AUTHENTICATED',
  'CLI_LIMIT',
  'CLI_TIMEOUT',
  'CLI_EXIT',
  'INVALID_OUTPUT',
  'WORKER_RESTARTED',
  'PROVIDER_UNAVAILABLE',
  'PROVIDER_RATE_LIMIT',
  'PROVIDER_UNSUPPORTED_REGION',
  'RESTRICTED_ASSET',
  'CANCELLED',
  'INTERNAL',
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ERROR_HTTP_STATUS: Record<ErrorCode, number> = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  REVISION_CONFLICT: 409,
  IDEMPOTENCY_CONFLICT: 409,
  ALREADY_COMMITTED: 409,
  EXPIRED: 410,
  VALIDATION_FAILED: 422,
  CONSTRAINT_UNSATISFIED: 422,
  RATE_LIMITED: 429,
  QUEUE_FULL: 429,
  UNAVAILABLE: 503,
  AI_UNAVAILABLE: 503,
  // CLI_* and INVALID_OUTPUT normally appear inside JobStatus.error, not as HTTP responses.
  CLI_NOT_AUTHENTICATED: 503,
  CLI_LIMIT: 429,
  CLI_TIMEOUT: 503,
  CLI_EXIT: 503,
  INVALID_OUTPUT: 502,
  WORKER_RESTARTED: 503,
  PROVIDER_UNAVAILABLE: 503,
  PROVIDER_RATE_LIMIT: 429,
  PROVIDER_UNSUPPORTED_REGION: 422,
  RESTRICTED_ASSET: 422,
  CANCELLED: 409,
  INTERNAL: 500,
};

export const ApiError = z.object({
  code: ErrorCode,
  message: z.string(),
  retryable: z.boolean(),
  requestId: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
});
export type ApiError = z.infer<typeof ApiError>;

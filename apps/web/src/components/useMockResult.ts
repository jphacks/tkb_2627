import { useCallback, useEffect, useState } from 'react';
import type { ApiError } from '@tkb/contracts';
import type { MockResult } from '../mocks/index.ts';

/** Error result for an exception thrown by an API call (e.g. a contract mismatch inside the mock). */
export function thrownToError(e: unknown): ApiError {
  return { code: 'INTERNAL', message: e instanceof Error ? e.message : '予期しないエラーが発生しました。', retryable: true, requestId: 'client_error' };
}

export function thrownToResult<T>(e: unknown): MockResult<T> {
  return { ok: false, error: thrownToError(e), source: 'mock', status: 500 };
}

export type AsyncResult<T> = { status: 'loading' } | { status: 'done'; result: MockResult<T> };

/**
 * Runs a mock API call when the component mounts / `key` changes and again on reload().
 * A stale response (after unmount or key change) is ignored.
 */
export function useMockResult<T>(load: () => Promise<MockResult<T>>, key: string): [AsyncResult<T>, () => void] {
  const [state, setState] = useState<AsyncResult<T>>({ status: 'loading' });
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let live = true;
    setState({ status: 'loading' });
    // A thrown error becomes an error result, so the screen never stays in "loading" forever.
    void load()
      .catch((e: unknown): MockResult<T> => thrownToResult(e))
      .then(result => {
        if (live) setState({ status: 'done', result });
      });
    return () => {
      live = false;
    };
    // `load` closes over the api for this key; reload() bumps nonce.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, nonce]);
  const reload = useCallback(() => setNonce(n => n + 1), []);
  return [state, reload];
}

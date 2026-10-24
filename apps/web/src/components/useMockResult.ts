import { useCallback, useEffect, useState } from 'react';
import type { MockResult } from '../mocks/index.ts';

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
    void load().then(result => {
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

import type { MockResult } from '../mocks/index.ts';

/** Shows where a result came from (source: 'mock') and the HTTP status the real API would use. */
export function SourceBadge({ result }: { result: Pick<MockResult<unknown>, 'source' | 'status'> }) {
  return (
    <span className="u1-source" title="この画面のデータの出どころ">
      出典: {result.source}（HTTP {result.status}）
    </span>
  );
}

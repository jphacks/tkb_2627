export interface ErrorInfo {
  message: string;
  code?: string;
  retryable?: boolean;
  requestId?: string;
}

/** Error with its code and request id (for reporting). Retry is offered only when a handler is given. */
export function ErrorBox({ error, title = 'エラーが発生しました', onRetry, retryLabel = '再試行' }: {
  error: ErrorInfo;
  title?: string;
  onRetry?: () => void;
  retryLabel?: string;
}) {
  return (
    <div role="alert" className="u1-error">
      <strong>{title}</strong>
      <p>{error.message}</p>
      <p className="meta">
        {error.code ? `コード: ${error.code}` : ''}
        {error.retryable === undefined ? '' : `（再試行${error.retryable ? '可' : '不可'}）`}
        {error.requestId ? ` / リクエストID: ${error.requestId}` : ''}
      </p>
      {onRetry && (
        <button type="button" className="btn" onClick={onRetry}>{retryLabel}</button>
      )}
    </div>
  );
}

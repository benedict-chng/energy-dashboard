import type { ApiError } from "../api/client";

interface Props {
  error: ApiError;
  onRetry: () => void;
}

/** Error banner showing the API's own error text plus a retry button. */
export function ErrorBanner({ error, onRetry }: Props) {
  return (
    <div className="error-banner" role="alert">
      <span>
        <strong>API error{error.status > 0 ? ` (${error.status})` : ""}:</strong> {error.message}
      </span>
      <button type="button" onClick={onRetry}>
        Retry
      </button>
    </div>
  );
}

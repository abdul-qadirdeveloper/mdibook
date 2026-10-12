// An error, in plain words: what happened and what to do next. Never internal details or
// personal data. A server error shows its reference id (R88). The title starts with "Error:"
// so the meaning does not depend on colour.
import type { ReactNode } from "react";

export interface ErrorMessageProps {
  /** What happened, for example "that time was just taken". Shown after "Error:". */
  title: string;
  /** What happened in a sentence, and what to do next. */
  message: string;
  /** The request reference id, when the server gave one. */
  requestId?: string | null;
  /** Actions that help the person recover, such as a retry button. */
  children?: ReactNode;
}

export function ErrorMessage({ title, message, requestId, children }: ErrorMessageProps) {
  return (
    <div className="error-message" role="alert">
      <h2 className="error-message__title">Error: {title}</h2>
      <p>{message}</p>
      {children ? <div className="button-row">{children}</div> : null}
      {requestId ? <p className="error-message__reference">Reference: {requestId}</p> : null}
    </div>
  );
}

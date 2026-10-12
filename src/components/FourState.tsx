// Every screen defines four states: loading, empty, error, success (R86). A screen wraps its
// content in this component and must say what each of the other three looks like.
import type { ReactNode } from "react";
import { ErrorMessage } from "@/components/ErrorMessage";

export type ScreenState = "loading" | "empty" | "error" | "success";

export interface FourStateProps {
  state: ScreenState;
  /** For example "Loading your appointments". */
  loadingLabel: string;
  /** What to show when there is nothing yet, including what the person can do next. */
  empty: ReactNode;
  /** Required whenever state can be "error". */
  error?: { title: string; message: string; requestId?: string | null };
  /** Called by the "Try again" button of the error state. */
  onRetry?: () => void;
  /** The success state. */
  children: ReactNode;
}

export function FourState({ state, loadingLabel, empty, error, onRetry, children }: FourStateProps) {
  if (state === "loading") {
    return (
      <p className="state state--loading" role="status" aria-live="polite">
        {loadingLabel}…
      </p>
    );
  }
  if (state === "error") {
    return (
      <ErrorMessage
        title={error?.title ?? "this could not be loaded"}
        message={error?.message ?? "Something went wrong on our side. Try again."}
        requestId={error?.requestId}
      >
        {onRetry ? (
          <button type="button" className="button" onClick={onRetry}>
            Try again
          </button>
        ) : null}
      </ErrorMessage>
    );
  }
  if (state === "empty") return <div className="card state">{empty}</div>;
  return <>{children}</>;
}

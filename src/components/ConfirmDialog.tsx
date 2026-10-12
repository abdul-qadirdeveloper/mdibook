"use client";

// Destructive actions (cancel, time off) ask for confirmation and state the consequence before
// anything happens (R43, R53). A native modal dialog: focus moves into it, Escape closes it,
// and focus returns to the button that opened it.
import { type ReactNode, useEffect, useId, useRef } from "react";

export interface ConfirmDialogProps {
  open: boolean;
  /** The question, for example "Cancel this appointment?". */
  title: string;
  /** What will happen if the person confirms. Required: the consequence is always stated. */
  consequence: ReactNode;
  /** The confirming button says what it does, for example "Cancel appointment". */
  confirmLabel: string;
  /** The other button, for example "Keep appointment". */
  dismissLabel: string;
  /** True while the action is being carried out. */
  busy?: boolean;
  onConfirm: () => void;
  onDismiss: () => void;
}

export function ConfirmDialog({
  open,
  title,
  consequence,
  confirmLabel,
  dismissLabel,
  busy = false,
  onConfirm,
  onDismiss,
}: ConfirmDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const consequenceId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="dialog"
      aria-labelledby={titleId}
      aria-describedby={consequenceId}
      onCancel={(event) => {
        // Escape. Keep the dialog under the parent's control.
        event.preventDefault();
        if (!busy) onDismiss();
      }}
    >
      <h2 id={titleId}>{title}</h2>
      <div id={consequenceId}>{consequence}</div>
      <div className="button-row">
        {/* The safe choice comes first and takes the initial focus. */}
        <button type="button" className="button button--secondary" onClick={onDismiss} disabled={busy} autoFocus>
          {dismissLabel}
        </button>
        <button type="button" className="button button--danger" onClick={onConfirm} disabled={busy}>
          {busy ? "Working…" : confirmLabel}
        </button>
      </div>
    </dialog>
  );
}

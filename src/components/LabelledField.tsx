// A form control with a visible label, an optional hint and an error (R87, R89). The error
// names the problem and never repeats the value typed.
import { type ReactNode, useId } from "react";

export interface FieldControlProps {
  id: string;
  "aria-describedby": string | undefined;
  "aria-invalid": boolean | undefined;
}

export interface LabelledFieldProps {
  label: string;
  hint?: string;
  /** The problem with this field, for example "Enter a reason of 200 characters or fewer". */
  error?: string | null;
  /** Renders the control. Spread the given props onto the input, select or textarea. */
  children: (control: FieldControlProps) => ReactNode;
}

export function LabelledField({ label, hint, error, children }: LabelledFieldProps) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;
  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {label}
      </label>
      {hint ? (
        <span className="field__hint" id={hintId}>
          {hint}
        </span>
      ) : null}
      {children({ id, "aria-describedby": describedBy, "aria-invalid": error ? true : undefined })}
      {error ? (
        <span className="field__error" id={errorId}>
          Error: {error}
        </span>
      ) : null}
    </div>
  );
}

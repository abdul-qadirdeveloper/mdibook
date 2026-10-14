// The patient screens (Stream A): Find a doctor, Doctor profile, Confirm booking and
// My appointments. The header and navigation come from the root layout.
import type { ReactNode } from "react";
import "./patient.css";

export default function PatientLayout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

import type { Metadata } from "next";
import type { ReactNode } from "react";
import { type NavLink, SiteHeader } from "@/components/SiteHeader";
import "./globals.css";

export const metadata: Metadata = {
  title: "MediBook",
  description: "Appointment booking for small clinics.",
};

// Navigation for every role, written once, with every final link. FROZEN after Stream 0:
// Streams A and B build the pages behind these links and do not edit this list.
// Stream A owns /patient/*, Stream B owns /clinic/*.
const NAV_LINKS: readonly NavLink[] = [
  { href: "/patient/doctors", label: "Find a doctor", roles: ["patient"] },
  { href: "/patient/appointments", label: "My appointments", roles: ["patient"] },
  { href: "/clinic/schedule", label: "Schedule", roles: ["doctor", "staff"] },
  { href: "/clinic/patients", label: "Book for a patient", roles: ["staff"] },
  { href: "/clinic/schedule-settings", label: "Working hours", roles: ["doctor", "staff"] },
  { href: "/clinic/time-off", label: "Time off", roles: ["doctor", "staff"] },
  { href: "/clinic/settings", label: "Clinic settings", roles: ["staff"] },
];

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <a className="skip-link" href="#main">
          Skip to main content
        </a>
        <SiteHeader links={NAV_LINKS} />
        <main id="main" className="page">
          {children}
        </main>
      </body>
    </html>
  );
}

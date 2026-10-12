"use client";

// The header: brand, the navigation for the current role, and who the browser is acting as.
// The links themselves are defined once, in src/app/layout.tsx.
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useMemo, useSyncExternalStore } from "react";
import { type DevUser, parseDevUser, readDevUserSnapshot, subscribeDevUser } from "@/lib/api-client";

export interface NavLink {
  href: string;
  label: string;
  roles: readonly DevUser["role"][];
}

export function SiteHeader({ links }: { links: readonly NavLink[] }) {
  const pathname = usePathname();
  const snapshot = useSyncExternalStore(subscribeDevUser, readDevUserSnapshot, () => null);
  const user = useMemo(() => parseDevUser(snapshot), [snapshot]);
  const visible = user ? links.filter((link) => link.roles.includes(user.role)) : [];

  return (
    <header className="site-header">
      <div className="site-header__inner">
        <Link href="/" className="site-header__brand">
          MediBook
        </Link>
        {visible.length > 0 ? (
          <nav className="site-nav" aria-label="Main">
            <ul>
              {visible.map((link) => (
                <li key={link.href}>
                  <Link href={link.href} aria-current={pathname.startsWith(link.href) ? "page" : undefined}>
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        ) : null}
        <div className="site-header__session">
          {user ? (
            <>
              <span>Acting as {user.label}</span>
              <Link href="/" className="button button--secondary">
                Switch user
              </Link>
            </>
          ) : (
            <span>No user chosen</span>
          )}
        </div>
      </div>
    </header>
  );
}

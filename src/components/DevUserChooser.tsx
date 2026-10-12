"use client";

// DEVELOPMENT STAND-IN. Chooses which seeded user the browser acts as. This is not sign-in:
// the real sign-in screen (R98) is not built and has no approved mock yet.
import { useMemo, useSyncExternalStore } from "react";
import { type DevUser, parseDevUser, readDevUserSnapshot, setDevUser, subscribeDevUser } from "@/lib/api-client";

export function DevUserChooser({ users }: { users: readonly DevUser[] }) {
  const snapshot = useSyncExternalStore(subscribeDevUser, readDevUserSnapshot, () => null);
  const current = useMemo(() => parseDevUser(snapshot), [snapshot]);

  return (
    <>
      <p role="status" aria-live="polite">
        {current ? `You are acting as ${current.label}.` : "No user is chosen yet."}
      </p>
      <ul className="user-list">
        {users.map((user) => {
          const chosen = current?.userId === user.userId;
          return (
            <li key={user.userId}>
              <button
                type="button"
                className={chosen ? "button" : "button button--secondary"}
                aria-pressed={chosen}
                onClick={() => setDevUser(user)}
              >
                {user.label}
                {chosen ? " (chosen)" : ""}
              </button>
            </li>
          );
        })}
      </ul>
      {current ? (
        <p style={{ marginTop: "1rem" }}>
          <button type="button" className="button button--secondary" onClick={() => setDevUser(null)}>
            Stop acting as this user
          </button>
        </p>
      ) : null}
    </>
  );
}

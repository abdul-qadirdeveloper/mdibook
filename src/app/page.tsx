// Home. Until real sign-in exists this page holds the development user chooser, which only
// works outside production. It reads the database on every request, never at build time.
import { DevUserChooser } from "@/components/DevUserChooser";
import { ErrorMessage } from "@/components/ErrorMessage";
import { type DevUser, listDevUsers } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  if (process.env.NODE_ENV === "production") {
    return (
      <>
        <h1>MediBook</h1>
        <p>Sign-in is not available yet. Ask your clinic how to book in the meantime.</p>
      </>
    );
  }

  let users: DevUser[] | null = null;
  try {
    users = await listDevUsers();
  } catch {
    users = null;
  }

  return (
    <>
      <h1>MediBook</h1>
      <p className="muted">
        Development build. Sign-in is not built yet, so choose a seeded user to act as. All of them are
        fictional.
      </p>
      {users === null ? (
        <ErrorMessage
          title="the users could not be loaded"
          message="The database did not answer. Start it with make db, then run make migrate and make seed, and reload this page."
        />
      ) : users.length === 0 ? (
        <div className="card">
          <h2>No users yet</h2>
          <p>Run make seed to create fictional clinics, doctors, staff and patients, then reload this page.</p>
        </div>
      ) : (
        <section className="card" aria-labelledby="choose-user">
          <h2 id="choose-user">Choose a user</h2>
          <DevUserChooser users={users} />
        </section>
      )}
    </>
  );
}

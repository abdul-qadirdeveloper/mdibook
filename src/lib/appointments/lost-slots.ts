// Which slots each signed-in user lost to SLOT_TAKEN on a reschedule, so the reschedule.conflict
// log line can say whether this session already lost the same slot (spec 003 R14).
//
// A session is the signed-in user id, and a lost slot is remembered for 15 minutes (spec 003 F9,
// option a). The memory is in this process only: it holds ids and instants, is never logged and
// is never persisted. It resets on restart and is not shared across instances, so in a
// multi-instance deploy the flag undercounts.

const REMEMBER_MS = 15 * 60_000;

interface LostSlot {
  doctorId: string;
  startMs: number;
  lostAt: number;
}

const lostByUser = new Map<string, LostSlot[]>();

/** The user's lost slots still inside the 15 minutes. Drops the older ones. */
function current(userId: string, now: Date): LostSlot[] {
  const kept = (lostByUser.get(userId) ?? []).filter((s) => now.getTime() - s.lostAt < REMEMBER_MS);
  if (kept.length > 0) lostByUser.set(userId, kept);
  else lostByUser.delete(userId);
  return kept;
}

/** True when this user lost the same slot (same doctor, same start) in the last 15 minutes. */
export function hasLost(userId: string, doctorId: string, start: Date, now: Date): boolean {
  return current(userId, now).some((s) => s.doctorId === doctorId && s.startMs === start.getTime());
}

/** Remembers that this user lost this slot now. */
export function recordLost(userId: string, doctorId: string, start: Date, now: Date): void {
  const kept = current(userId, now).filter((s) => !(s.doctorId === doctorId && s.startMs === start.getTime()));
  kept.push({ doctorId, startMs: start.getTime(), lostAt: now.getTime() });
  lostByUser.set(userId, kept);
}

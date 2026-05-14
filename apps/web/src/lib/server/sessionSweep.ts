// Sweep expired session rows during control-plane boot.
//
// The storage primitive `deleteExpiredSessions` (in
// `@tex-center/db`) has lived since iter 54; this is the first
// periodic caller. Production wiring (in `server.ts`) invokes
// this after `runBootMigrations` and before `boot()` so a fresh
// Machine starts with a tidy session table.
//
// Gated by two env vars, mirroring `bootMigrations`:
//
//   - `DATABASE_URL` must be set (stateless mode has no session
//     table to sweep).
//   - `SWEEP_SESSIONS_ON_BOOT` must equal "1". Defaulting off
//     keeps the sweep a deliberate opt-in: on a multi-Machine
//     deploy one Machine taking the cost is sufficient, and ops
//     may want to run it out-of-band against a `flyctl proxy`.
//
// A boot-time one-shot is the simplest scheduler that meets the
// goal — every deploy produces fresh Machines, so the sweep
// runs at least once per deploy cadence. A periodic in-process
// timer is a possible upgrade once the deploy rhythm slows
// (FUTURE_IDEAS).

import {
  closeDb,
  createDb,
  deleteExpiredSessions,
} from "@tex-center/db";

export type SessionSweepStatus =
  | { kind: "skipped-no-database-url" }
  | { kind: "skipped-disabled" }
  | { kind: "swept"; removed: number };

export interface SessionSweepDeps {
  sweep(url: string, now: Date): Promise<number>;
}

export const defaultSessionSweepDeps: SessionSweepDeps = {
  sweep: async (url, now) => {
    const handle = createDb(url, { max: 1, onnotice: () => {} });
    try {
      return await deleteExpiredSessions(handle.db, now);
    } finally {
      await closeDb(handle);
    }
  },
};

export async function runBootSessionSweep(
  env: Readonly<Record<string, string | undefined>>,
  deps: SessionSweepDeps = defaultSessionSweepDeps,
  now: Date = new Date(),
): Promise<SessionSweepStatus> {
  const url = env.DATABASE_URL;
  if (!url) return { kind: "skipped-no-database-url" };
  if (env.SWEEP_SESSIONS_ON_BOOT !== "1") return { kind: "skipped-disabled" };

  const removed = await deps.sweep(url, now);
  return { kind: "swept", removed };
}

export function describeSessionSweepStatus(s: SessionSweepStatus): string {
  switch (s.kind) {
    case "skipped-no-database-url":
      return "session sweep: skipped (DATABASE_URL not set)";
    case "skipped-disabled":
      return "session sweep: skipped (SWEEP_SESSIONS_ON_BOOT != \"1\")";
    case "swept":
      return `session sweep: removed ${s.removed} expired row${s.removed === 1 ? "" : "s"}`;
  }
}

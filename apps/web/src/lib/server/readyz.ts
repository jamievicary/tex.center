// Pure helper for the `/readyz` route. Probes optional backing
// services and returns a structured readiness payload. The route
// composes this with `process.env.DATABASE_URL`-gated `getDb()` and
// turns `ok: false` into HTTP 503.
//
// `/readyz` is deliberately a *separate* endpoint from `/healthz`:
// liveness must stay decoupled from Postgres so a transient outage
// can't unready every web Machine. Readiness probes are for callers
// that explicitly want to gate on backing-service availability
// (deploy verification, external monitors).

import { errorMessage } from "../errors.js";

export type ReadyState = "absent" | "up" | "down";

export interface ReadyDb {
  state: ReadyState;
  error?: string;
}

export interface ReadyResult {
  ok: boolean;
  protocol: string;
  db: ReadyDb;
}

export interface ReadyzDeps {
  // `null` => no DB handle configured (DATABASE_URL unset).
  // Otherwise resolves on probe success, rejects on probe failure.
  probeDb: () => Promise<void> | null;
}

export const READYZ_PROTOCOL = "tex-center-web-v1";

export async function probeReady(deps: ReadyzDeps): Promise<ReadyResult> {
  const probe = deps.probeDb();
  let db: ReadyDb;
  if (probe === null) {
    db = { state: "absent" };
  } else {
    try {
      await probe;
      db = { state: "up" };
    } catch (e) {
      db = { state: "down", error: errorMessage(e) };
    }
  }
  return {
    ok: db.state !== "down",
    protocol: READYZ_PROTOCOL,
    db,
  };
}

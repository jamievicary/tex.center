// Process-lifetime DbHandle singleton for the control-plane.
//
// Mirrors the sidecar pattern: the connection is created lazily on
// first use from `DATABASE_URL`, kept open for the life of the
// node process, and closed on `SIGTERM`/`SIGINT`. `getDb()` throws
// a clear message if `DATABASE_URL` is unset — callers that have
// a legitimate "no db" mode should check the env first.

import { createDb, closeDb, type DbHandle } from "@tex-center/db";

let handle: DbHandle | null = null;
let shutdownHookInstalled = false;

export function getDb(): DbHandle {
  if (handle) return handle;
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set; apps/web cannot reach Postgres",
    );
  }
  handle = createDb(url);
  installShutdownHook();
  return handle;
}

function installShutdownHook(): void {
  if (shutdownHookInstalled) return;
  shutdownHookInstalled = true;
  const close = async () => {
    const h = handle;
    handle = null;
    if (h) await closeDb(h);
  };
  process.once("SIGTERM", () => void close());
  process.once("SIGINT", () => void close());
}

// Readiness probe. Reports backing-service status (DB today, blobs
// when a control-plane blob store lands). HTTP 503 on `!ok` so a
// caller can gate on it; `/healthz` remains the liveness probe.

import type { RequestHandler } from "@sveltejs/kit";

import { getDb } from "$lib/server/db";
import { probeReady } from "$lib/server/readyz";

export const prerender = false;

export const GET: RequestHandler = async () => {
  const result = await probeReady({
    probeDb: () => {
      if (!process.env.DATABASE_URL) return null;
      const handle = getDb();
      return handle.client`SELECT 1`.then(() => undefined);
    },
  });
  return new Response(JSON.stringify(result), {
    status: result.ok ? 200 : 503,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
};

// Liveness probe for Fly's HTTP healthcheck.
//
// Deliberately decoupled from any backing service: a transient
// Postgres or Tigris outage must NOT cause Fly to mark every web
// Machine unready and route traffic to nothing. If/when we want
// readiness-with-deps, it goes on a separate /readyz endpoint.

import type { RequestHandler } from "@sveltejs/kit";

export const prerender = false;

export const GET: RequestHandler = async () => {
  return new Response(
    JSON.stringify({ ok: true, protocol: "tex-center-web-v1" }),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
    },
  );
};

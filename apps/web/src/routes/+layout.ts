// Default to `ssr = false` (SPA shell) with prerender opted out per-
// page. Every concrete page (`/`, `/projects`, `/editor/[projectId]`)
// has its own `+page.ts` setting `prerender = false` so that
// `hooks.server.ts`'s `routeRedirect` runs on every request — a
// prerendered HTML file is served by the edge without invoking the
// hook, which would let an authed visitor land on `/` (the white
// sign-in page) instead of being bounced to `/projects`. Adapter is
// `adapter-node` (iter 34).
export const ssr = false;

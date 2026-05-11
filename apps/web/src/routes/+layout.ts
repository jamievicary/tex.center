// Default to prerender so static pages (the landing page, marketing-
// less though it is) ship as build-time HTML. Server-only routes
// (`+server.ts`) and authenticated pages opt out locally:
// `/editor/+page.ts` sets `prerender = false` so the session hook
// runs on every request. Adapter is `adapter-node` (iter 34).
export const prerender = true;
export const ssr = false;

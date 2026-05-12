// Override the layout's `prerender = true` for the landing page.
//
// `hooks.server.ts` redirects authenticated visitors away from `/`
// (the white sign-in page) to `/projects`; a prerendered static
// HTML file is served by the edge without ever invoking the hook,
// so an authed user landing on `/` in production would see the
// sign-in button instead of being bounced to the dashboard. Local
// Vite dev SSRs unconditionally and masks the issue.
export const prerender = false;
export const ssr = false;

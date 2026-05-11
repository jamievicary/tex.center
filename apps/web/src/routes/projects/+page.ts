// Override the layout's `prerender = true` for the dashboard.
//
// `hooks.server.ts` redirects unauthenticated visitors away from
// `/projects`; a prerendered HTML file would never give the hook
// a chance to run.
export const prerender = false;
export const ssr = false;

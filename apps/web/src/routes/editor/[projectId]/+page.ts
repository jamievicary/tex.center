// Override the layout's `prerender = true` for the editor.
//
// `hooks.server.ts` redirects unauthenticated visitors away from
// `/editor`; a prerendered HTML file would never give the hook a
// chance to run. `ssr = false` is kept — the editor shell is
// still client-rendered, the request just goes through the server
// so the auth gate can short-circuit.
export const prerender = false;
export const ssr = false;

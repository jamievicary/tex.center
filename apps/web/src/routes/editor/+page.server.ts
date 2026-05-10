// Server-side load for the editor page. Surfaces the authenticated
// user's identity (email + display name) so the page can render a
// header with a sign-out affordance.
//
// `hooks.server.ts` guarantees a session here (the `/editor` prefix
// is protected and unauthenticated requests are 302'd to `/`); the
// non-null assertion below is a type narrowing, not a runtime
// invariant we expect to fail.

import type { PageServerLoad } from "./$types.js";

export const load: PageServerLoad = ({ locals }) => {
  const session = locals.session;
  if (session === null) {
    // Belt-and-braces: hook should already have redirected.
    return { user: null };
  }
  return {
    user: {
      email: session.user.email,
      displayName: session.user.displayName,
    },
  };
};

// Server-side load for the editor page.
//
// `hooks.server.ts` guarantees a session here (the `/editor`
// prefix is protected and unauthenticated requests are 302'd to
// `/`). We additionally look up the project by id and 404 if it
// doesn't exist or isn't owned by the current user — so a
// stale/guessed URL can't drive the WS at someone else's project.

import { error } from "@sveltejs/kit";

import { getDb } from "$lib/server/db.js";
import { getProjectById } from "@tex-center/db";

import type { PageServerLoad } from "./$types.js";

export const load: PageServerLoad = async ({ locals, params }) => {
  const session = locals.session;
  if (session === null) {
    // Belt-and-braces: hook should already have redirected.
    return { user: null, project: null };
  }
  const { db } = getDb();
  const project = await getProjectById(db, params.projectId);
  if (project === null || project.ownerId !== session.user.id) {
    throw error(404, "Project not found");
  }
  return {
    user: {
      email: session.user.email,
      displayName: session.user.displayName,
    },
    project: {
      id: project.id,
      name: project.name,
    },
  };
};

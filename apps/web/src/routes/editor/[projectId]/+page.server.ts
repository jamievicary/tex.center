// Server-side load for the editor page.
//
// `hooks.server.ts` guarantees a session here (the `/editor`
// prefix is protected and unauthenticated requests are 302'd to
// `/`). We additionally look up the project by id and 404 if it
// doesn't exist or isn't owned by the current user — so a
// stale/guessed URL can't drive the WS at someone else's project.

import { error } from "@sveltejs/kit";

import { getDb } from "$lib/server/db.js";
import {
  getMachineAssignmentByProjectId,
  getProjectById,
} from "@tex-center/db";
import { MAIN_DOC_HELLO_WORLD, MAIN_DOC_NAME } from "@tex-center/protocol";

import type { PageServerLoad } from "./$types.js";

export const load: PageServerLoad = async ({ locals, params }) => {
  const session = locals.session;
  if (session === null) {
    // Belt-and-braces: hook should already have redirected.
    return { user: null, project: null, seed: null };
  }
  const { db } = getDb();
  const project = await getProjectById(db, params.projectId);
  if (project === null || project.ownerId !== session.user.id) {
    throw error(404, "Project not found");
  }

  // M13.2(a): when the project has never had a sidecar Machine
  // assigned (i.e. no `machine_assignments` row), no WS has ever
  // upgraded for it, so the sidecar's authoritative state for this
  // project is still just the canonical seed template. Surface that
  // template to the client so CodeMirror can paint in hundreds of
  // ms — bypassing the ~11.5 s cold-start WS upgrade that GT-6 pins.
  // The client renders the seed as a placeholder `.cm-content`; it
  // never writes the seed into the local Y.Doc, so the CRDT cannot
  // duplicate the sidecar's identical seed once initial sync lands.
  const assignment = await getMachineAssignmentByProjectId(db, project.id);
  const seed =
    assignment === null
      ? { name: MAIN_DOC_NAME, text: MAIN_DOC_HELLO_WORLD }
      : null;

  return {
    user: {
      email: session.user.email,
      displayName: session.user.displayName,
    },
    project: {
      id: project.id,
      name: project.name,
    },
    seed,
  };
};

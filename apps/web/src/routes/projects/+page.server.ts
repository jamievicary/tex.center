// Projects dashboard server load + "new project" form action.
//
// Lists the authenticated user's projects (ordered by created_at)
// and accepts a POST that creates a new project then 302s to its
// editor URL. `hooks.server.ts` guarantees a session here.

import { error, fail, redirect } from "@sveltejs/kit";

import { getDb } from "$lib/server/db.js";
import { deleteProject } from "$lib/server/deleteProject.js";
import {
  createProject,
  getProjectById,
  listProjectsByOwnerId,
} from "@tex-center/db";

import type { Actions, PageServerLoad } from "./$types.js";

export const load: PageServerLoad = async ({ locals }) => {
  const session = locals.session;
  if (session === null) {
    return { projects: [] };
  }
  const { db } = getDb();
  const rows = await listProjectsByOwnerId(db, session.user.id);
  return {
    projects: rows.map((r) => ({ id: r.id, name: r.name })),
  };
};

export const actions: Actions = {
  create: async ({ request, locals }) => {
    const session = locals.session;
    if (session === null) throw error(401, "Not signed in");
    const form = await request.formData();
    const raw = form.get("name");
    const name = typeof raw === "string" ? raw.trim() : "";
    if (name.length === 0 || name.length > 200) {
      return fail(400, { reason: "Project name must be 1–200 chars" });
    }
    const { db } = getDb();
    const project = await createProject(db, {
      ownerId: session.user.id,
      name,
    });
    throw redirect(303, `/editor/${project.id}`);
  },

  delete: async ({ request, locals }) => {
    const session = locals.session;
    if (session === null) throw error(401, "Not signed in");
    const form = await request.formData();
    const raw = form.get("projectId");
    const projectId = typeof raw === "string" ? raw.trim() : "";
    if (projectId === "") return fail(400, { reason: "Missing projectId" });

    const { db } = getDb();
    const existing = await getProjectById(db, projectId);
    if (existing === null) {
      // Already gone — treat as success and bounce back.
      throw redirect(303, "/projects");
    }
    if (existing.ownerId !== session.user.id) {
      throw error(403, "Not your project");
    }

    await deleteProject({ db, projectId, env: process.env });
    throw redirect(303, "/projects");
  },
};

// Authed GET `/` redirects to `/projects` (the signed-in home).
// Mirror image of the unauthed landing.spec test: the same path,
// with a valid session cookie attached, should never show the
// white sign-in page. Enforced by `routeRedirect` in the
// SvelteKit server hook.

import { expect, test } from "./fixtures/authedPage.js";

test("authed visit to / lands on /projects", async ({ authedPage }) => {
  const response = await authedPage.goto("/");
  // After redirect handling, the final navigation should be on
  // /projects with a 200. The intermediate 302 is invisible here;
  // both correctness signals (final URL + status) are what matter.
  expect(response?.status(), "final GET status").toBe(200);
  expect(new URL(authedPage.url()).pathname).toBe("/projects");

  // And it's the projects dashboard, not some stub: the H1 is
  // present and identifies the page.
  await expect(authedPage.getByRole("heading", { name: "Projects" })).toBeVisible();
});

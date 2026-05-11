// Clicking the sign-out form on `/projects` posts to
// `/auth/logout`, which 303s to `/` while clearing the
// `tc_session` cookie. After the redirect the page must be the
// white sign-in page (no cookie → routeRedirect does nothing for
// anonymous on `/`).

import { expect, test } from "./fixtures/authedPage.js";

test("sign-out clears the cookie and lands on /", async ({ authedPage }) => {
  await authedPage.goto("/projects");

  // Sanity: the session cookie was attached by the fixture.
  const cookiesBefore = await authedPage.context().cookies();
  expect(cookiesBefore.find((c) => c.name === "tc_session")).toBeDefined();

  // Submit the form synchronously and wait for the post-redirect
  // navigation to `/` to settle.
  await Promise.all([
    authedPage.waitForURL("**/"),
    authedPage.locator('form[action="/auth/logout"] button[type="submit"]').click(),
  ]);

  expect(new URL(authedPage.url()).pathname).toBe("/");

  // The browser should have cleared the session cookie via the
  // Set-Cookie header on the 303.
  const cookiesAfter = await authedPage.context().cookies();
  expect(
    cookiesAfter.find((c) => c.name === "tc_session"),
    "tc_session cookie should be cleared after sign-out",
  ).toBeUndefined();

  // White page invariant from landing.spec: exactly one sign-in link.
  await expect(
    authedPage.getByRole("link", { name: "Sign in with Google" }),
  ).toBeVisible();
});

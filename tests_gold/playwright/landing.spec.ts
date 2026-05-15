// GOAL.md acceptance criterion #1: the unauthenticated landing
// page reveals NOTHING about the service — no name, description,
// or marketing copy — only the sign-in widget. This test asserts
// that invariant at the DOM level.

// Import from the gold-suite's extended `test` so this spec picks
// up the per-worker `baseURL` override (each local Playwright
// worker runs its own SvelteKit dev server on `3000 + workerIndex`).
import { expect, test } from "./fixtures/authedPage.js";

const SIGNIN_TEXT = "Sign in with Google";

test("landing page has only a sign-in widget and no marketing copy", async ({
  page,
}) => {
  const response = await page.goto("/");
  expect(response?.status(), "GET / status").toBe(200);

  // The only interactive control is the sign-in anchor.
  const signin = page.getByRole("link", { name: SIGNIN_TEXT });
  await expect(signin).toBeVisible();
  await expect(signin).toHaveAttribute("href", "/auth/google/start");

  // No buttons or other links — the page is intentionally barren.
  await expect(page.locator("button")).toHaveCount(0);
  await expect(page.locator("a")).toHaveCount(1);

  // The page's entire visible text content is the sign-in label.
  // Any other rendered prose would be marketing copy by definition.
  const bodyText = (await page.locator("body").innerText()).trim();
  expect(bodyText).toBe(SIGNIN_TEXT);
});

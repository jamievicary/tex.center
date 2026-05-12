"""Static checks for the unauthenticated landing page (`/`).

GOAL.md acceptance #1 forbids hinting at what the service is from
the unauthenticated landing page. A widget pointing at `/editor`
(the previous mock) would leak that hint to view-source. The button
must instead start the real OAuth flow at `/auth/google/start`.
"""

from __future__ import annotations

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PAGE = ROOT / "apps" / "web" / "src" / "routes" / "+page.svelte"
PAGE_TS = ROOT / "apps" / "web" / "src" / "routes" / "+page.ts"
START_ROUTE = ROOT / "apps" / "web" / "src" / "routes" / "auth" / "google" / "start" / "+server.ts"


class TestLandingSignIn(unittest.TestCase):
    def setUp(self) -> None:
        self.assertTrue(PAGE.is_file(), f"missing {PAGE.relative_to(ROOT)}")
        self.src = PAGE.read_text()

    def test_oauth_start_route_exists(self) -> None:
        # The page targets `/auth/google/start`; if the route file
        # ever moves this test must scream.
        self.assertTrue(
            START_ROUTE.is_file(),
            f"missing {START_ROUTE.relative_to(ROOT)} — landing page would 404",
        )

    def test_sign_in_targets_oauth_start(self) -> None:
        self.assertRegex(
            self.src,
            r'href\s*=\s*"/auth/google/start"',
        )

    def test_does_not_link_to_editor(self) -> None:
        # The unauth landing page must not reveal the editor's
        # existence. Any reference to `/editor` (anchor, JS nav, form
        # action) is a regression of the previous mock.
        self.assertNotIn("/editor", self.src)

    def test_no_marketing_copy(self) -> None:
        # Visible text must be exactly the sign-in label. Crude
        # check: collapse the rendered markup's text nodes outside
        # <style> blocks and assert the only words are the label.
        without_style = re.sub(
            r"<style[\s\S]*?</style>", "", self.src, flags=re.IGNORECASE
        )
        without_script = re.sub(
            r"<script[\s\S]*?</script>", "", without_style, flags=re.IGNORECASE
        )
        without_comments = re.sub(r"<!--[\s\S]*?-->", "", without_script)
        text = re.sub(r"<[^>]+>", " ", without_comments)
        visible = " ".join(text.split())
        self.assertEqual(visible, "Sign in with Google")

    def test_prerender_disabled(self) -> None:
        # `routeRedirect` in `hooks.server.ts` bounces authenticated
        # GETs of `/` to `/projects`. A prerendered static HTML file
        # is served by the edge without invoking the hook, so an
        # authed user would land on the sign-in page in production
        # (local Vite dev SSRs unconditionally and masks the bug).
        # Guard: `apps/web/src/routes/+page.ts` must explicitly opt
        # out of the layout's default.
        self.assertTrue(PAGE_TS.is_file(), f"missing {PAGE_TS.relative_to(ROOT)}")
        self.assertRegex(
            PAGE_TS.read_text(),
            r"export\s+const\s+prerender\s*=\s*false",
        )


if __name__ == "__main__":
    unittest.main()

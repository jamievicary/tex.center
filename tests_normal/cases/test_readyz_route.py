"""Static checks for the `/readyz` SvelteKit route.

`/readyz` is the readiness probe sibling of `/healthz`: it composes
the pure `probeReady` helper with a `DATABASE_URL`-gated DB probe.
Behaviour is unit-tested in `apps/web/test/readyz.test.mjs`; here we
pin the wiring at the file level (route exists, exports `GET`,
prerender disabled, no-store, references the helper, returns 503 on
failure).
"""

from __future__ import annotations

import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ROUTE = ROOT / "apps" / "web" / "src" / "routes" / "readyz" / "+server.ts"


class TestReadyzRoute(unittest.TestCase):
    def setUp(self) -> None:
        self.assertTrue(ROUTE.is_file(), f"missing {ROUTE.relative_to(ROOT)}")
        self.src = ROUTE.read_text()

    def test_exports_get_handler(self) -> None:
        self.assertRegex(self.src, r"export\s+const\s+GET\s*:")

    def test_prerender_disabled(self) -> None:
        # Same reasoning as `/healthz`: a prerendered response would
        # serve "ok" from the static layer even on a half-broken
        # Node process or a wedged DB.
        self.assertRegex(self.src, r"export\s+const\s+prerender\s*=\s*false")

    def test_no_cache(self) -> None:
        self.assertIn("no-store", self.src)

    def test_invokes_probe_ready(self) -> None:
        self.assertIn("probeReady", self.src)

    def test_gated_on_database_url(self) -> None:
        # Without DATABASE_URL the route must report "absent" (not
        # call getDb() and throw). The route encodes that with a
        # process.env.DATABASE_URL guard.
        self.assertIn("DATABASE_URL", self.src)

    def test_failure_returns_503(self) -> None:
        # `!ok` → 503 so external monitors / deploy verification can
        # gate on readiness without parsing the body.
        self.assertIn("503", self.src)


if __name__ == "__main__":
    unittest.main()

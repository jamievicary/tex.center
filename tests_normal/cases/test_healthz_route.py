"""Static checks for the `/healthz` SvelteKit route.

The route file is a TypeScript module loaded by `adapter-node` at
runtime; we can't import it from Python. What we CAN check is that
the source file exists, exports a `GET` handler, returns JSON
including `ok: true` and a versioned protocol string, and sets
`Cache-Control: no-store`. Drift between the route and the Fly
healthcheck path is caught by `test_fly_toml.py`.
"""

from __future__ import annotations

import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ROUTE = ROOT / "apps" / "web" / "src" / "routes" / "healthz" / "+server.ts"


class TestHealthzRoute(unittest.TestCase):
    def setUp(self) -> None:
        self.assertTrue(ROUTE.is_file(), f"missing {ROUTE.relative_to(ROOT)}")
        self.src = ROUTE.read_text()

    def test_exports_get_handler(self) -> None:
        self.assertRegex(self.src, r"export\s+const\s+GET\s*:")

    def test_payload_marks_ok(self) -> None:
        self.assertIn("ok: true", self.src)

    def test_payload_carries_protocol_marker(self) -> None:
        self.assertIn("tex-center-web-v1", self.src)

    def test_no_cache(self) -> None:
        self.assertIn("no-store", self.src)

    def test_prerender_disabled(self) -> None:
        # Liveness probe must run server-side; a prerendered
        # response would be served from the static asset layer and
        # report "ok" even on a half-broken Node process.
        self.assertRegex(self.src, r"export\s+const\s+prerender\s*=\s*false")


if __name__ == "__main__":
    unittest.main()

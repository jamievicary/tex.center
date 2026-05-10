"""Static structural checks for the control-plane fly.toml.

We don't `flyctl deploy` from tests_normal — that needs Fly creds
and a remote builder. What we CAN do is enforce that the manifest
stays consistent with the architecture decisions recorded in
PLAN.md: scale-to-zero, internal port matching the Dockerfile,
build context pointing at apps/web/Dockerfile.
"""

from __future__ import annotations

import re
import tomllib
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
FLY_TOML = ROOT / "fly.toml"
DOCKERFILE = ROOT / "apps" / "web" / "Dockerfile"
HEALTHZ_ROUTE = (
    ROOT / "apps" / "web" / "src" / "routes" / "healthz" / "+server.ts"
)


class TestFlyToml(unittest.TestCase):
    def setUp(self) -> None:
        self.assertTrue(FLY_TOML.is_file(), "fly.toml missing at repo root")
        self.cfg = tomllib.loads(FLY_TOML.read_text())

    def test_app_name(self) -> None:
        self.assertEqual(self.cfg.get("app"), "tex-center")

    def test_primary_region_set(self) -> None:
        # Single region for MVP; Fly requires it pinned at create time.
        self.assertIsInstance(self.cfg.get("primary_region"), str)
        self.assertNotEqual(self.cfg["primary_region"], "")

    def test_build_dockerfile_points_at_web(self) -> None:
        build = self.cfg.get("build", {})
        self.assertEqual(build.get("dockerfile"), "apps/web/Dockerfile")

    def test_http_service_scale_to_zero(self) -> None:
        # Control plane must scale to zero between sessions — see
        # GOAL.md "always-on Machine that scales to zero".
        svc = self.cfg.get("http_service", {})
        self.assertEqual(svc.get("auto_stop_machines"), "stop")
        self.assertIs(svc.get("auto_start_machines"), True)
        self.assertEqual(svc.get("min_machines_running"), 0)

    def test_http_service_port_matches_dockerfile(self) -> None:
        # The Dockerfile exposes / binds 3000 (HOST=0.0.0.0,
        # PORT=3000). If we drift here Fly's edge will route to a
        # closed port and every request 502s.
        svc = self.cfg.get("http_service", {})
        self.assertEqual(svc.get("internal_port"), 3000)
        dockertext = DOCKERFILE.read_text()
        self.assertRegex(dockertext, r"PORT=3000\b")
        self.assertRegex(dockertext, r"(?m)^EXPOSE\s+3000\b")

    def test_http_service_forces_https(self) -> None:
        # The product is HTTPS-only (cookies are Secure on https://).
        svc = self.cfg.get("http_service", {})
        self.assertIs(svc.get("force_https"), True)

    def test_http_service_check_points_at_healthz(self) -> None:
        # Fly's HTTP readiness probe must hit a real route in
        # apps/web. If the path drifts, every Machine boots into
        # "unhealthy" and the deploy hangs.
        svc = self.cfg.get("http_service", {})
        checks = svc.get("checks", [])
        self.assertTrue(
            checks,
            "fly.toml should declare at least one [[http_service.checks]] block",
        )
        paths = {c.get("path") for c in checks}
        self.assertIn("/healthz", paths)
        self.assertTrue(
            HEALTHZ_ROUTE.is_file(),
            f"fly.toml references /healthz but {HEALTHZ_ROUTE.relative_to(ROOT)} missing",
        )
        # Probe should be a cheap GET; POST/PUT would imply
        # side-effects and Fly wouldn't retry idempotently.
        for c in checks:
            if c.get("path") == "/healthz":
                self.assertEqual(c.get("method", "GET").upper(), "GET")


if __name__ == "__main__":
    unittest.main()

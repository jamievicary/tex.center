"""Static structural checks for the sidecar fly.toml (M7.0.2).

Mirrors test_fly_toml.py for the control plane: we can't deploy
from tests_normal, but we can enforce that the manifest stays
consistent with the architecture decisions in PLAN.md — 6PN-only
(no public IPs), internal port matches the Dockerfile, `fra`
region, build context pointing at apps/sidecar/Dockerfile.
"""

from __future__ import annotations

import tomllib
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
FLY_TOML = ROOT / "apps" / "sidecar" / "fly.toml"
DOCKERFILE = ROOT / "apps" / "sidecar" / "Dockerfile"


class TestSidecarFlyToml(unittest.TestCase):
    def setUp(self) -> None:
        self.assertTrue(
            FLY_TOML.is_file(), "apps/sidecar/fly.toml missing"
        )
        self.cfg = tomllib.loads(FLY_TOML.read_text())

    def test_app_name(self) -> None:
        self.assertEqual(self.cfg.get("app"), "tex-center-sidecar")

    def test_primary_region(self) -> None:
        # Co-located with the control plane (fra) so 6PN hops stay
        # in-region; the WS proxy in M7.0.3 is latency-sensitive.
        self.assertEqual(self.cfg.get("primary_region"), "fra")

    def test_build_dockerfile_points_at_sidecar(self) -> None:
        # The path is resolved relative to this fly.toml's
        # directory (apps/sidecar/), not the build context — so
        # the value is just "Dockerfile". See the comment in
        # fly.toml and deploy/README.md.
        build = self.cfg.get("build", {})
        self.assertEqual(build.get("dockerfile"), "Dockerfile")
        sibling = FLY_TOML.parent / build["dockerfile"]
        self.assertTrue(
            sibling.is_file(),
            f"fly.toml dockerfile path resolves to {sibling}, which is missing",
        )

    def test_no_public_http_service(self) -> None:
        # 6PN-only. An [http_service] block would auto-allocate
        # public IPs the first time the app is deployed; we
        # explicitly want zero public attack surface here.
        self.assertNotIn("http_service", self.cfg)
        # Same for any [[services]] block that exposes ports
        # publicly — allowed only if it declares no
        # [[services.ports]] (which would defeat its purpose, so
        # we just forbid the block outright at this stage).
        self.assertNotIn("services", self.cfg)

    def test_vm_size_set(self) -> None:
        vms = self.cfg.get("vm", [])
        self.assertTrue(vms, "fly.toml should declare at least one [[vm]]")
        vm = vms[0]
        # texlive-full + supertex + Node sidecar comfortably
        # exceed 512mb at idle; bump to 1gb for the shared tier.
        self.assertEqual(vm.get("memory"), "1gb")
        self.assertEqual(vm.get("size"), "shared-cpu-1x")

    def test_dockerfile_port_matches_3001(self) -> None:
        # If this drifts the WS proxy in M7.0.3 will connect to a
        # closed port on the 6PN side and every editor session
        # 502s. Lock 3001 down on both sides.
        text = DOCKERFILE.read_text()
        self.assertRegex(text, r"PORT=3001\b")
        self.assertRegex(text, r"(?m)^EXPOSE\s+3001\b")


if __name__ == "__main__":
    unittest.main()

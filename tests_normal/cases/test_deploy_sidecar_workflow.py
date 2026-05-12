"""Structural checks for the sidecar Fly deploy GitHub Actions workflow.

Mirrors `test_deploy_workflow.py` for the sidecar app. We can't run
`flyctl deploy` from tests_normal, but we can enforce the invariants
that, if they drifted, would silently break path-gated sidecar
deploys: trigger (push to main with path filter + workflow_dispatch),
checkout-with-submodules (the Dockerfile needs `vendor/supertex`),
setup-flyctl, and the exact `flyctl deploy` command with both `-a`
and `--config` (the canonical form PLAN insists on).
"""

from __future__ import annotations

import unittest
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = ROOT / ".github" / "workflows" / "deploy-sidecar.yml"


class TestSidecarDeployWorkflow(unittest.TestCase):
    def setUp(self) -> None:
        self.assertTrue(WORKFLOW.is_file(), "deploy-sidecar.yml missing")
        self.doc = yaml.safe_load(WORKFLOW.read_text())

    def _on(self) -> dict:
        # PyYAML quirk: bare key `on:` parses as boolean True.
        return self.doc.get("on") or self.doc.get(True)

    def test_triggers_on_push_to_main_with_paths(self) -> None:
        on = self._on()
        self.assertIsInstance(on, dict)
        push = on.get("push")
        self.assertIsInstance(push, dict)
        self.assertEqual(push.get("branches"), ["main"])
        paths = push.get("paths") or []
        # Must gate on the sidecar tree and on the workflow file
        # itself; otherwise edits to the workflow can't deploy.
        for required in (
            "apps/sidecar/**",
            "vendor/engine/**",
            ".github/workflows/deploy-sidecar.yml",
        ):
            self.assertIn(required, paths)

    def test_supports_manual_dispatch(self) -> None:
        on = self._on()
        self.assertIn("workflow_dispatch", on)

    def test_has_deploy_job_on_ubuntu(self) -> None:
        jobs = self.doc.get("jobs", {})
        self.assertIn("deploy", jobs)
        self.assertEqual(jobs["deploy"].get("runs-on"), "ubuntu-latest")

    def test_checkout_pulls_submodules(self) -> None:
        # `vendor/supertex` is a git submodule and the sidecar
        # Dockerfile COPYs from it; checkout must therefore set
        # submodules: recursive (or true) or the build fails.
        steps = self.doc["jobs"]["deploy"]["steps"]
        checkouts = [
            s for s in steps if (s.get("uses") or "").startswith("actions/checkout@")
        ]
        self.assertEqual(len(checkouts), 1)
        with_ = checkouts[0].get("with") or {}
        self.assertIn(with_.get("submodules"), ("recursive", "true", True))

    def test_checkout_supplies_submodule_token(self) -> None:
        # vendor/supertex is a private repo on the same GitHub
        # account; the default GITHUB_TOKEN only has access to the
        # current repo, so a PAT is required to clone the submodule.
        # Iter 151 discovered the sidecar workflow had been silently
        # failing every run since at least iter 124 because of this.
        steps = self.doc["jobs"]["deploy"]["steps"]
        checkouts = [
            s for s in steps if (s.get("uses") or "").startswith("actions/checkout@")
        ]
        with_ = checkouts[0].get("with") or {}
        token = with_.get("token") or ""
        self.assertIn(
            "SUBMODULE_TOKEN",
            token,
            f"checkout must pass a PAT secret as `token:` to clone the "
            f"private vendor/supertex submodule, got token={token!r}",
        )

    def test_uses_setup_flyctl(self) -> None:
        steps = self.doc["jobs"]["deploy"]["steps"]
        uses = [s.get("uses", "") for s in steps]
        self.assertTrue(
            any(u.startswith("superfly/flyctl-actions/setup-flyctl") for u in uses),
            f"expected setup-flyctl step, got uses={uses}",
        )

    def test_runs_flyctl_deploy_with_canonical_flags(self) -> None:
        steps = self.doc["jobs"]["deploy"]["steps"]
        deploy_steps = [s for s in steps if "flyctl deploy" in (s.get("run") or "")]
        self.assertEqual(
            len(deploy_steps), 1, "expected exactly one flyctl deploy step"
        )
        run = deploy_steps[0]["run"]
        # PLAN explicitly requires both `-a` and `--config` on every
        # sidecar deploy invocation.
        self.assertIn("--remote-only", run)
        self.assertIn("--no-public-ips", run)
        self.assertIn("-a tex-center-sidecar", run)
        self.assertIn("--config apps/sidecar/fly.toml", run)
        env = deploy_steps[0].get("env", {})
        self.assertEqual(
            env.get("FLY_API_TOKEN"), "${{ secrets.FLY_API_TOKEN }}"
        )

    def test_fly_config_exists(self) -> None:
        # If the workflow references apps/sidecar/fly.toml, it must
        # actually exist or `flyctl deploy` errors out on the runner.
        self.assertTrue((ROOT / "apps/sidecar/fly.toml").is_file())


if __name__ == "__main__":
    unittest.main()

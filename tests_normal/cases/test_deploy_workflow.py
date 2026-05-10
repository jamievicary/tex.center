"""Structural checks for the Fly deploy GitHub Actions workflow.

We can't execute `flyctl deploy` from tests_normal (no creds, no
remote builder). What we CAN do is enforce the structural invariants
that, if drifted, would make pushes to `main` silently stop
deploying: trigger branch, action references, the deploy command,
and the `FLY_API_TOKEN` secret wiring.
"""

from __future__ import annotations

import unittest
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = ROOT / ".github" / "workflows" / "deploy.yml"


class TestDeployWorkflow(unittest.TestCase):
    def setUp(self) -> None:
        self.assertTrue(WORKFLOW.is_file(), "deploy.yml missing")
        self.doc = yaml.safe_load(WORKFLOW.read_text())

    def test_triggers_on_push_to_main(self) -> None:
        # PyYAML parses the bare key `on:` as the boolean True
        # (YAML 1.1 quirk). Accept either spelling.
        on = self.doc.get("on") or self.doc.get(True)
        self.assertIsInstance(on, dict)
        push = on.get("push")
        self.assertIsInstance(push, dict)
        self.assertEqual(push.get("branches"), ["main"])

    def test_has_deploy_job_on_ubuntu(self) -> None:
        jobs = self.doc.get("jobs", {})
        self.assertIn("deploy", jobs)
        self.assertEqual(jobs["deploy"].get("runs-on"), "ubuntu-latest")

    def test_steps_check_out_and_setup_flyctl(self) -> None:
        steps = self.doc["jobs"]["deploy"]["steps"]
        uses = [s.get("uses", "") for s in steps]
        self.assertTrue(
            any(u.startswith("actions/checkout@") for u in uses),
            f"expected actions/checkout step, got uses={uses}",
        )
        self.assertTrue(
            any(u.startswith("superfly/flyctl-actions/setup-flyctl") for u in uses),
            f"expected setup-flyctl step, got uses={uses}",
        )

    def test_runs_flyctl_deploy_with_token(self) -> None:
        steps = self.doc["jobs"]["deploy"]["steps"]
        deploy_steps = [s for s in steps if "flyctl deploy" in (s.get("run") or "")]
        self.assertEqual(
            len(deploy_steps), 1, "expected exactly one flyctl deploy step"
        )
        step = deploy_steps[0]
        # Remote builder: no docker on the runner.
        self.assertIn("--remote-only", step["run"])
        # FLY_API_TOKEN must be threaded through from the repo secret.
        env = step.get("env", {})
        self.assertEqual(
            env.get("FLY_API_TOKEN"), "${{ secrets.FLY_API_TOKEN }}"
        )

    def test_dockerfile_reference_exists(self) -> None:
        # If the workflow names a Dockerfile path, that file must
        # actually exist — otherwise the deploy fails on Fly's
        # builder with a confusing context error.
        steps = self.doc["jobs"]["deploy"]["steps"]
        for s in steps:
            run = s.get("run") or ""
            if "--dockerfile" in run:
                parts = run.split()
                idx = parts.index("--dockerfile")
                path = parts[idx + 1]
                self.assertTrue(
                    (ROOT / path).is_file(),
                    f"workflow references missing Dockerfile: {path}",
                )


if __name__ == "__main__":
    unittest.main()

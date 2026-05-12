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

    def test_smoke_job_gates_deploy(self) -> None:
        # M8.smoke.0: the runtime image must be built and probed for
        # module-load failures before flyctl deploy runs. If this
        # gating drifts, the iter-129 incident class (adapter-node
        # externalised npm dep missing from runtime stage) returns
        # silently to production.
        jobs = self.doc.get("jobs", {})
        self.assertIn("smoke", jobs, "smoke job missing from deploy.yml")
        self.assertEqual(jobs["smoke"].get("runs-on"), "ubuntu-latest")

        # The smoke job must invoke the script. Workflows shell out
        # rather than inlining curl loops so the same logic can be
        # run locally (`bash scripts/smoke-runtime-image.sh`).
        steps = jobs["smoke"]["steps"]
        runs = [s.get("run") or "" for s in steps]
        self.assertTrue(
            any("scripts/smoke-runtime-image.sh" in r for r in runs),
            f"smoke job must call scripts/smoke-runtime-image.sh; got {runs}",
        )
        script = ROOT / "scripts" / "smoke-runtime-image.sh"
        self.assertTrue(script.is_file(), "smoke script missing")
        self.assertTrue(
            script.stat().st_mode & 0o111, "smoke script not executable"
        )

        # Deploy must wait for smoke.
        deploy_needs = jobs["deploy"].get("needs")
        if isinstance(deploy_needs, str):
            deploy_needs = [deploy_needs]
        self.assertIn(
            "smoke",
            deploy_needs or [],
            "deploy job must declare `needs: smoke`",
        )

    def test_smoke_script_probes_all_endpoints(self) -> None:
        # The seven endpoints named in PLAN M8.smoke.0 must all be
        # exercised. Drift here (someone deleting a probe to silence
        # a failure) is exactly the regression this test guards.
        script_text = (ROOT / "scripts" / "smoke-runtime-image.sh").read_text()
        for path in [
            "GET /",
            "GET /healthz",
            "GET /readyz",
            "GET /auth/google/start",
            "GET /auth/google/callback?error=fake",
            "POST /auth/logout",
            "GET /projects",
            "GET /editor/abc123",
        ]:
            self.assertIn(
                path,
                script_text,
                f"smoke script missing probe for {path!r}",
            )
        # The module-not-found scan is the whole point — guard it.
        self.assertIn("ERR_MODULE_NOT_FOUND", script_text)
        self.assertIn("Cannot find package", script_text)

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

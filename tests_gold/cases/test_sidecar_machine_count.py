"""Sidecar Machine-count guardrail (M9.resource-hygiene).

Asserts that `tex-center-sidecar` has no more Machines than
`TEXCENTER_MAX_SIDECAR_MACHINES` (default 10). Catches leaks from
live specs that fail to call `cleanupLiveProjectMachine` in
`afterEach` (see `173b_question.md` / `173b_answer.md`).

Threshold history: 5 originally — the live deploy was used only
by Playwright artifacts. By iter 290 the human user had created
~5 manual `Test`/`Test11`/`Xxdsz`-named projects via the live
dashboard, each owning a per-project Machine that the count
includes. Iter 293 bumped to 10 to accommodate ongoing user
growth while still catching runaway leaks (a leaking suite still
hits 20+ Machines fast — pre-iter-243 incidents saw 30+
overnight). The iter-293 globalSetup stale-`pw-*` sweep
(`cleanupOldPlaywrightProjects.ts`) reaps Playwright leftovers
older than 10 minutes, so this test's threshold doesn't need to
account for accumulating test artifacts.

M9.live-hygiene.leaked-machines (iter 243): Machines whose
`config.metadata.fly_process_group == "app"` are the intentional
shared-pool deployment machines (M7.0.2) Fly's deploy machinery
mints from `apps/sidecar/fly.toml`; they are excluded from the
count. Per-project sidecars created by the control plane now
carry `config.metadata.texcenter_project=<projectId>`
(`apps/web/src/lib/server/upstreamResolver.ts`); those + any
metadata-less legacy machines remain in scope.

On breach the assertion message lists every counted Machine's id,
created_at, state, name, and metadata tags so the operator can
triage / destroy.

Skips silently if `creds/fly.token` is missing (e.g. a non-
maintainer clone running the suite). All other failure modes
(HTTP error, non-JSON body, missing fields) surface as test
failures so a real Fly API regression doesn't get masked.
"""

from __future__ import annotations

import json
import os
import unittest
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CREDS = ROOT / "creds"
APP_NAME = os.environ.get("SIDECAR_APP_NAME", "tex-center-sidecar")
DEFAULT_MAX = 10


def _load_token() -> str | None:
    path = CREDS / "fly.token"
    if not path.is_file():
        return None
    token = path.read_text().strip()
    return token or None


class TestSidecarMachineCount(unittest.TestCase):
    def test_machine_count_under_threshold(self) -> None:
        token = _load_token()
        if token is None:
            raise unittest.SkipTest(
                "creds/fly.token absent; sidecar Machine-count guardrail "
                "only runs in the maintainer environment"
            )
        max_count = int(
            os.environ.get("TEXCENTER_MAX_SIDECAR_MACHINES", str(DEFAULT_MAX))
        )

        url = f"https://api.machines.dev/v1/apps/{APP_NAME}/machines"
        req = urllib.request.Request(
            url,
            headers={"Authorization": f"Bearer {token}"},
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                body = resp.read().decode("utf-8")
                status = resp.status
        except urllib.error.HTTPError as e:
            self.fail(
                f"Fly Machines API GET {url} returned {e.code}: "
                f"{e.read().decode('utf-8', errors='replace')}"
            )
        except urllib.error.URLError as e:
            self.fail(f"Fly Machines API GET {url} failed: {e}")

        if status != 200:
            self.fail(f"Fly Machines API GET {url} returned status {status}")

        try:
            machines = json.loads(body)
        except json.JSONDecodeError as e:
            self.fail(f"Fly Machines API returned non-JSON body: {e}; body={body!r}")

        if not isinstance(machines, list):
            self.fail(f"Fly Machines API returned non-list body: {machines!r}")

        def is_shared_pool(m: dict) -> bool:
            cfg = m.get("config") or {}
            md = cfg.get("metadata") or {}
            return md.get("fly_process_group") == "app"

        counted = [m for m in machines if not is_shared_pool(m)]
        if len(counted) <= max_count:
            return

        lines = [
            f"{APP_NAME} has {len(counted)} non-shared Machines "
            f"(of {len(machines)} total), threshold is {max_count} "
            "(TEXCENTER_MAX_SIDECAR_MACHINES). Likely cause: a live "
            "spec failed to reap its per-project Machine. "
            "Triage / destroy:"
        ]
        for m in counted:
            mid = m.get("id", "<no id>")
            created = m.get("created_at", "<no created_at>")
            state = m.get("state", "<no state>")
            name = m.get("name", "<no name>")
            md = (m.get("config") or {}).get("metadata") or {}
            tag = md.get("texcenter_project", "<untagged>")
            lines.append(
                f"  - {mid} name={name} state={state} "
                f"created={created} texcenter_project={tag}"
            )
        self.fail("\n".join(lines))

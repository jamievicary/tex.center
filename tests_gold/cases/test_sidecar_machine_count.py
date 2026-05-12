"""Sidecar Machine-count guardrail (M9.resource-hygiene).

Asserts that `tex-center-sidecar` has no more Machines than
`TEXCENTER_MAX_SIDECAR_MACHINES` (default 5). Catches leaks from
live specs that fail to call `cleanupLiveProjectMachine` in
`afterEach` (see `173b_question.md` / `173b_answer.md`).

On breach the assertion message lists every Machine's id,
created_at, and state so the operator can triage / destroy.

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
DEFAULT_MAX = 5


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

        if len(machines) <= max_count:
            return

        lines = [
            f"{APP_NAME} has {len(machines)} Machines, threshold is "
            f"{max_count} (TEXCENTER_MAX_SIDECAR_MACHINES). Likely "
            "cause: a live spec failed to reap its per-project "
            "Machine. Triage / destroy:"
        ]
        for m in machines:
            mid = m.get("id", "<no id>")
            created = m.get("created_at", "<no created_at>")
            state = m.get("state", "<no state>")
            name = m.get("name", "<no name>")
            lines.append(f"  - {mid} name={name} state={state} created={created}")
        self.fail("\n".join(lines))

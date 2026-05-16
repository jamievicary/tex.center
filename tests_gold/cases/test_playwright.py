"""Playwright gold case (M8.pw.0 + M8.pw.4).

Two cases: a `local`-target run against an auto-booted SvelteKit
dev server, and a `live`-target run against https://tex.center.

The live case is the per-iter readout of "is the live product
working" (per `162_question.md` / `166_question.md`). It runs on
every gold invocation: credentials are loaded directly from
`creds/` (gitignored, maintainer-local) and exported as the env
vars `authedPage` requires. If `creds/` is incomplete or
unparseable the case fails with a message naming the missing
field/file — it does not skip silently. (Absent creds are real
configuration breakage that should surface as an iteration goal.)

Chromium is provisioned by `tests_gold/setup_playwright.sh`
(idempotent).
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CONFIG = ROOT / "tests_gold" / "playwright.config.ts"
CREDS = ROOT / "creds"


def _env_with_node() -> dict[str, str]:
    env = os.environ.copy()
    node_bin = ROOT / ".tools" / "node" / "bin"
    env["PATH"] = f"{node_bin}{os.pathsep}{env.get('PATH', '')}"
    # Point Playwright at our vendored browser cache.
    env["PLAYWRIGHT_BROWSERS_PATH"] = str(ROOT / ".tools" / "playwright")
    # Force monochrome list-reporter output so the harness's awk
    # parser doesn't have to strip ANSI sequences to find ✓ / ✘ /
    # skipped lines.
    env["FORCE_COLOR"] = "0"
    env["NO_COLOR"] = "1"
    return env


def _setup_playwright() -> None:
    subprocess.run(
        ["bash", str(ROOT / "tests_gold" / "setup_playwright.sh")],
        cwd=ROOT,
        env=_env_with_node(),
        check=True,
        timeout=600,
    )


def _read_creds_file(name: str) -> str:
    path = CREDS / name
    if not path.is_file():
        raise AssertionError(
            f"live spec requires {path} but the file is missing. "
            "Live credentials are maintainer-local (creds/ is "
            "gitignored); restore the file before running gold."
        )
    return path.read_text()


def _extract(text: str, pattern: str, *, file: str, field: str) -> str:
    m = re.search(pattern, text, flags=re.MULTILINE)
    if m is None:
        raise AssertionError(
            f"live spec could not parse {field!r} out of "
            f"creds/{file} (pattern {pattern!r} did not match). "
            "The file format may have drifted; fix the file or "
            "update tests_gold/cases/test_playwright.py:_load_live_creds."
        )
    return m.group(1).strip()


def _load_live_creds() -> dict[str, str]:
    """Read live credentials from `creds/` and return env-var assignments.

    Each missing/unparseable file fails loudly with a message that
    names the file and the field that wasn't found. Never returns
    an empty value.
    """
    fly_pg = _read_creds_file("fly-postgres.txt")
    signing = _read_creds_file("session-signing-key.txt")
    user = _read_creds_file("live-user-id.txt")
    # `creds/fly.token` is a single-line `flyctl` auth token used
    # to authorise the `flyctl proxy` invoked by the `authedPage`
    # worker fixture against `tex-center-db`. Without it the proxy
    # child exits immediately with "no access token available"
    # before any test body runs.
    fly_token = _read_creds_file("fly.token").strip()
    if not fly_token:
        raise AssertionError(
            "live spec requires creds/fly.token but the file is empty."
        )

    # `creds/fly-postgres.txt` lists the superuser block as
    #   Superuser:
    #     username: postgres
    #     password: <value>
    # Match the first `password:` line — that is the superuser.
    password = _extract(
        fly_pg,
        r"^\s*password:\s*(\S+)\s*$",
        file="fly-postgres.txt",
        field="superuser password",
    )

    # `creds/session-signing-key.txt` has the key on its own
    # indented line directly below the "base64url-encoded:" header.
    signing_key = _extract(
        signing,
        r"base64url-encoded:\s*\n\s*([A-Za-z0-9_-]+)",
        file="session-signing-key.txt",
        field="SESSION_SIGNING_KEY (base64url)",
    )

    # `creds/live-user-id.txt` has the row's UUID under
    #   id:          <uuid>
    user_id = _extract(
        user,
        r"^\s*id:\s*([0-9a-f-]{36})\s*$",
        file="live-user-id.txt",
        field="user id (uuid)",
    )

    return {
        "TEXCENTER_LIVE_DB_PASSWORD": password,
        "SESSION_SIGNING_KEY": signing_key,
        "TEXCENTER_LIVE_USER_ID": user_id,
        "FLY_API_TOKEN": fly_token,
    }


class TestPlaywright(unittest.TestCase):
    def test_playwright(self) -> None:
        # Single Playwright invocation runs both `local` and `live`
        # projects in one process: one globalSetup, one dev server
        # boot, one Chromium download check. Live creds are loaded
        # unconditionally and exported into the env; the live
        # specs gate themselves on `TEXCENTER_FULL_PIPELINE=1` and
        # `testInfo.project.name === "live"`.
        if not (ROOT / "node_modules").exists():
            raise unittest.SkipTest(
                "node_modules missing; run tests_normal first"
            )
        if shutil.which("pnpm") is None and not (
            ROOT / "node_modules" / ".bin" / "pnpm"
        ).exists() and not (
            ROOT / ".tools" / "node" / "bin" / "pnpm"
        ).exists():
            raise unittest.SkipTest("pnpm not on PATH")

        env = _env_with_node()
        # Live creds: missing/unparseable fails loudly per
        # `166_question.md`. Absent creds are real configuration
        # breakage that should surface as an iteration goal.
        env.update(_load_live_creds())
        env["TEXCENTER_FULL_PIPELINE"] = "1"

        _setup_playwright()

        # Outer timeout sized to absorb globalSetup (~240 s budget)
        # + ~25 live specs + local specs + GT-9's per-test 8-min wall
        # if it actually fires. 1200 s = 20 min: a real regression
        # surfaces, but a single slow spec doesn't truncate the rest.
        try:
            result = subprocess.run(
                [
                    "pnpm",
                    "exec",
                    "playwright",
                    "test",
                    "--config",
                    str(CONFIG),
                ],
                cwd=ROOT,
                env=env,
                capture_output=True,
                text=True,
                timeout=1200,
            )
        except subprocess.TimeoutExpired as exc:
            # subprocess.run with capture_output=True attaches whatever
            # was captured before the timeout to the exception's
            # stdout/stderr attributes. Without this dump every outer
            # timeout produces zero diagnostic output — every per-spec
            # ✓ / ✘ line and every test-side console.log (e.g. GT-9's
            # `[verifyLiveGt9StoppedPreservesEdits] elapsedMs=…
            # phase=…` markers) is lost. Iter-335's phase-marker
            # diagnostic was effectively invisible until this lands.
            if exc.stdout:
                sys.stdout.write(exc.stdout)
            if exc.stderr:
                sys.stderr.write(exc.stderr)
            sys.stdout.flush()
            sys.stderr.flush()
            raise AssertionError(
                f"playwright timed out after {exc.timeout}s "
                "— see captured output above (which may be partial); "
                "the last logged phase from any in-progress spec "
                "names where it was stuck"
            ) from exc
        # Always echo the Playwright list-reporter output so its
        # per-spec ✓ / ✘ lines reach $GOLD_OUT and surface as
        # individual pass/fail entries in the iteration log
        # (autodev/iterate_one.sh's awk pattern matches them).
        sys.stdout.write(result.stdout)
        sys.stderr.write(result.stderr)
        sys.stdout.flush()
        sys.stderr.flush()
        if result.returncode != 0:
            raise AssertionError(
                f"playwright failed (exit {result.returncode}) "
                "— see ✓ / ✘ lines above for per-spec breakdown"
            )

"""Playwright gold case — first slice (M8.pw.0).

Runs the `local`-project Playwright suite against an
auto-booted SvelteKit dev server. The `live` project, which
targets https://tex.center, is gated on `TEXCENTER_LIVE_TESTS=1`
so the default `tests_gold` run doesn't beat on production.

Chromium is provisioned by `tests_gold/setup_playwright.sh`
(idempotent).
"""

from __future__ import annotations

import os
import shutil
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CONFIG = ROOT / "tests_gold" / "playwright.config.ts"


def _env_with_node() -> dict[str, str]:
    env = os.environ.copy()
    node_bin = ROOT / ".tools" / "node" / "bin"
    env["PATH"] = f"{node_bin}{os.pathsep}{env.get('PATH', '')}"
    # Point Playwright at our vendored browser cache.
    env["PLAYWRIGHT_BROWSERS_PATH"] = str(ROOT / ".tools" / "playwright")
    return env


def _setup_playwright() -> None:
    subprocess.run(
        ["bash", str(ROOT / "tests_gold" / "setup_playwright.sh")],
        cwd=ROOT,
        env=_env_with_node(),
        check=True,
        timeout=600,
    )


class TestPlaywrightLocal(unittest.TestCase):
    def test_local(self) -> None:
        # `pnpm --filter @tex-center/web dev` requires the SvelteKit
        # toolchain to be present in node_modules; tests_normal has
        # already run `pnpm install` before tests_gold fires, but
        # guard against standalone invocations.
        if not (ROOT / "node_modules").exists():
            raise unittest.SkipTest(
                "node_modules missing; run tests_normal first"
            )
        if shutil.which("pnpm") is None and not (
            ROOT / ".tools" / "node" / "bin" / "pnpm"
        ).exists():
            raise unittest.SkipTest("pnpm not on PATH")

        _setup_playwright()

        result = subprocess.run(
            [
                "pnpm",
                "exec",
                "playwright",
                "test",
                "--config",
                str(CONFIG),
                "--project=local",
            ],
            cwd=ROOT,
            env=_env_with_node(),
            capture_output=True,
            text=True,
            timeout=300,
        )
        if result.returncode != 0:
            raise AssertionError(
                f"playwright (local) failed (exit {result.returncode})\n"
                f"--- stdout ---\n{result.stdout}\n"
                f"--- stderr ---\n{result.stderr}"
            )


class TestPlaywrightLive(unittest.TestCase):
    def test_live(self) -> None:
        if os.environ.get("TEXCENTER_LIVE_TESTS") != "1":
            raise unittest.SkipTest(
                "skipped because TEXCENTER_LIVE_TESTS != 1"
            )

        _setup_playwright()

        env = _env_with_node()
        env["PLAYWRIGHT_SKIP_WEBSERVER"] = "1"
        result = subprocess.run(
            [
                "pnpm",
                "exec",
                "playwright",
                "test",
                "--config",
                str(CONFIG),
                "--project=live",
            ],
            cwd=ROOT,
            env=env,
            capture_output=True,
            text=True,
            timeout=300,
        )
        if result.returncode != 0:
            raise AssertionError(
                f"playwright (live) failed (exit {result.returncode})\n"
                f"--- stdout ---\n{result.stdout}\n"
                f"--- stderr ---\n{result.stderr}"
            )

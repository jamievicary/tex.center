#!/usr/bin/env python3
"""Parallel runner for `tests_gold/cases/test_*.py`.

Discovers every `test_*.py` under `tests_gold/cases/` and runs each
in its own subprocess via `python3 -m unittest <module> -v`. The
subprocesses run concurrently (capped by `TEXCENTER_GOLD_PARALLEL`,
default 4), and each module's full output is flushed to stdout/
stderr atomically (in completion order) so the autodev iterator's
awk parser sees the same per-test line shapes a serial `unittest
discover` would produce.

Why per-module subprocesses rather than threads:
- Each case shells out to its own toolchain (pnpm/tsx/supertex/
  lualatex/pglite), so the work is already process-isolated.
- The only shared external state worth worrying about is the live
  Fly app, which is touched by `test_sidecar_machine_count`
  (read-only `GET /machines`) and `test_playwright` (creates +
  reaps its own projects with unique names). They do not collide.
- The supertex CPU-bound cases will slow each other down under
  contention, but their subprocess timeouts (5-20 min) absorb that
  comfortably.

Exit status: 0 if every module passed, 1 otherwise.
"""

from __future__ import annotations

import os
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

ROOT = Path(__file__).resolve().parent
CASES_DIR = ROOT / "cases"


def discover_modules() -> list[str]:
    """Return sorted module names (without `.py`) of every gold case.

    Skips any file whose name contains `.tmp.` (orphan temp-files
    occasionally left behind by interrupted iterations).
    """
    return sorted(
        p.stem
        for p in CASES_DIR.glob("test_*.py")
        if ".tmp." not in p.name
    )


def run_module(module: str) -> tuple[str, int, str, str]:
    """Run one `unittest` module and return (name, rc, stdout, stderr).

    `cwd` is the cases dir so the module is importable by its
    short name. The case files derive paths from `__file__`, so
    cwd choice doesn't affect what they exercise.
    """
    proc = subprocess.run(
        [sys.executable, "-m", "unittest", module, "-v"],
        cwd=CASES_DIR,
        capture_output=True,
        text=True,
    )
    return module, proc.returncode, proc.stdout, proc.stderr


def main() -> int:
    modules = discover_modules()
    if not modules:
        print("run_parallel_cases.py: no gold cases discovered", file=sys.stderr)
        return 0
    try:
        workers = int(os.environ.get("TEXCENTER_GOLD_PARALLEL", "4"))
    except ValueError:
        workers = 4
    workers = max(1, min(workers, len(modules)))

    failed: list[str] = []
    print(
        f"run_parallel_cases.py: dispatching {len(modules)} module(s) "
        f"across {workers} worker(s)",
        file=sys.stderr,
    )
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {pool.submit(run_module, m): m for m in modules}
        for fut in as_completed(futures):
            module, rc, out, err = fut.result()
            # Emit each module's output atomically. Within the main
            # thread, `as_completed` yields one future at a time, so
            # writes from different modules cannot interleave.
            sys.stdout.write(out)
            sys.stderr.write(err)
            sys.stdout.flush()
            sys.stderr.flush()
            if rc != 0:
                failed.append(module)

    if failed:
        print(
            f"\nrun_parallel_cases.py: failed modules: {', '.join(failed)}",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

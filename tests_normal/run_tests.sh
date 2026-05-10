#!/usr/bin/env bash
# Normal test runner.
#
# Exit 0 if every normal test passes. Exit non-zero on any failure.
# A non-zero exit causes the harness to REVERT the iteration's code
# changes (the log is preserved).
#
# Currently runs:
#   - structural_checks.py: JSON validity, pnpm workspace coherence,
#     required-files / required-fields / cross-package references.
#   - any tests_normal/cases/test_*.py via unittest (parallelism is
#     trivial here while the suite is tiny; revisit once it grows).
#
# Linux Node is not yet installed in this environment (only the
# Windows-side node.exe is reachable from WSL), so `tsc --noEmit`
# is intentionally NOT wired in yet — see .autodev/PLAN.md "Local
# toolchain" for the plan to enable it.

set -euo pipefail

cd "$(dirname "$0")/.."

python3 tests_normal/structural_checks.py

if compgen -G "tests_normal/cases/test_*.py" >/dev/null; then
    python3 -m unittest discover -s tests_normal/cases -p "test_*.py" -v
fi

echo "tests_normal/run_tests.sh: PASS"

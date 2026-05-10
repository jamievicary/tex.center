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
#   - any tests_normal/cases/test_*.py via unittest.
#   - pnpm -r typecheck (tsc --noEmit across all workspace packages).
#
# Node lives at .tools/node (gitignored, vendored per-checkout). If
# missing, `tests_normal/setup_node.sh` fetches Node 20 LTS and
# activates pnpm via corepack. The script is idempotent.

set -euo pipefail

cd "$(dirname "$0")/.."

python3 tests_normal/structural_checks.py

if compgen -G "tests_normal/cases/test_*.py" >/dev/null; then
    python3 -m unittest discover -s tests_normal/cases -p "test_*.py" -v
fi

bash tests_normal/setup_node.sh
export PATH="$PWD/.tools/node/bin:$PATH"
pnpm -r typecheck

echo "tests_normal/run_tests.sh: PASS"

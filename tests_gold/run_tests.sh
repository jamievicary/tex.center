#!/usr/bin/env bash
# Gold test runner.
#
# Exit 0 if every gold test passes. Exit non-zero if any gold test
# fails or the suite cannot run.
#
# Gold tests are aspirational integration tests. A non-zero exit DOES
# NOT revert the iteration — it only blocks .autodev/finished.md
# (completion requires both tests_normal/ and tests_gold/ green). A
# failing gold case is a legitimate iteration goal.
#
# Cases live under `tests_gold/cases/test_*.py` and are discovered
# by `unittest`. Each case may shell out to `pnpm exec tsx` for
# Node-backed integration scripts. The Node toolchain is provisioned
# by `tests_normal/setup_node.sh`; the harness runs `tests_normal/`
# first so `.tools/node` is already populated, but we guard against
# standalone invocations.

set -euo pipefail

cd "$(dirname "$0")/.."

if [[ ! -x .tools/node/bin/node ]]; then
    bash tests_normal/setup_node.sh
fi
export PATH="$PWD/.tools/node/bin:$PATH"

if compgen -G "tests_gold/cases/test_*.py" >/dev/null; then
    python3 -m unittest discover -s tests_gold/cases -p "test_*.py" -v
else
    echo "tests_gold/run_tests.sh: no gold cases configured; treating as pass."
fi

echo "tests_gold/run_tests.sh: PASS"

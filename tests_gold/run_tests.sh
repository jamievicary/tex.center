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
# The agent maintains this script as the project takes shape. It
# should run cases under tests_gold/ in parallel where feasible.
#
# Initially a no-op so the harness can run from iteration 1 even
# before any gold cases exist.

set -euo pipefail

echo "tests_gold/run_tests.sh: no gold tests configured yet (placeholder); treating as pass."
exit 0

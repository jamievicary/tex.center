#!/usr/bin/env bash
# Normal test runner.
#
# Exit 0 if every normal test passes (or there is nothing to test).
# Exit non-zero if any normal test fails or the suite cannot run.
#
# A non-zero exit causes the harness to REVERT the iteration's code
# changes (the log is preserved). Normal tests are the
# "must-stay-green" suite — keep them deterministic and fast.
#
# The agent maintains this script as the project takes shape. It
# should run tests under tests_normal/ in parallel where feasible
# (e.g. `pytest -n auto`, `cargo test`, GNU `parallel`, `xargs -P`).
#
# Initially a no-op so the harness can run from iteration 1 even
# before any code exists.

set -euo pipefail

echo "tests_normal/run_tests.sh: no normal tests configured yet (placeholder); treating as pass."
exit 0

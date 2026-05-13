# GT-8 GREEN after upstream supertex bump + sidecar redeploy

All four tasks from `226_question.md` executed in this iteration.

## 1. Submodule bump

Already done by the harness in the iter-227 start commit
(`7000148`): `vendor/supertex` moved `f65afad → 2fb543e` (iter
754 → 758). The diff:

```
diff --git a/vendor/supertex b/vendor/supertex
-Subproject commit f65afad47997b6f2de650f0322010a7f3bd74a5f
+Subproject commit 2fb543efb6aa2bfa7c17f102adf078c3b5569ad4
```

Range includes the four fix commits called out in the question
(`tools/supertex_daemon.c` rollback-target fix + three new tests).

## 2. Sidecar redeploy

Ran the canonical command from `deploy/README.md`:

```sh
FLY_API_TOKEN=… flyctl deploy --remote-only --no-public-ips \
  -a tex-center-sidecar --config apps/sidecar/fly.toml .
```

Image:
`registry.fly.io/tex-center-sidecar:deployment-01KRHFMRMGCGY7CKAGA3RX0BN6`
sha256
`d8896500755689ca4477893b219d04b7e43c09848419bb0d1560f0e93aa3823e`
(1.9 GB). Rolling update completed on both Machines
(`d895e7ea479958`, `683437eb1e3378`, both in `fra`).

Then pinned the digest on the control-plane app per the iter-169
lesson (otherwise newly-minted per-project Machines would still
pull the previous image):

```sh
flyctl secrets set \
  "SIDECAR_IMAGE=registry.fly.io/tex-center-sidecar@sha256:d8896…" \
  -a tex-center
```

## 3. GT-8 verification — GREEN

```
[verifyLiveGt8] project=d2890ab2-15b5-4449-bc60-fe481cb83d3a
  coldStartMs=22166 framesSent=253 pdfSegments=2
  controlFrames=26 errorFrames=0
✓ verifyLiveGt8ColdProjectNewpageDaemonCrash.spec.ts (35.6s)
```

Cold-start was 22 s (well inside the window that historically
ramped the queue past the rollback target). Control frames are a
clean alternation of `compile-status running` / `idle`; **zero**
error frames; no `protocol violation`, no `child exited`, no
`stdin not writable`. This is the original iter-213 daemon-crash
signature staying absent under the literal user-reported repro.

Full gold suite then re-run end-to-end: 29 pass, 3 skip,
1 flake (GT-5 — see below). GT-7 and GT-8 both green.

## 4. PLAN update

Marked **M9.editor-ux.regress.gt7** (the daemon-crash thread)
closed in `.autodev/PLAN.md`. Compressed the iter-217..225
narrative — the full story is in the logs.

## Caveats

- **GT-5 flake.** First full gold run produced a single GT-5
  failure (pdfSegmentFrames count didn't bump after the edit;
  framesSent delta=23 was healthy). Re-running GT-5 alone:
  `✓ … (4.8s)`. Iter 226 also showed GT-5 green. Categorising as
  flake against a slow cold dev-server boot, not a regression
  from the supertex bump. Not separately fixed in this iteration
  (out of scope; would need its own diagnosis). If it recurs in
  the next gold pass, that's the next iteration's goal.
- **SIDECAR_TRACE_COALESCER plumbing.** Left in place as a
  passive diagnostic per the M9.gt7 close-out plan. Removing it
  is an optional cleanup; not blocking.
- **Iter 757–758 upstream tests.** Not vendored as gold cases
  here — they live in `vendor/supertex/tests/`. Our existing
  `tests_gold/lib/test/supertexColdNewpageCrash.test.mjs`
  exercises the same code paths through the embedded daemon and
  stayed green throughout (it always was — that's why iter 225's
  local probe couldn't repro; the bug needed the live cold-start
  budget).

# Iter 148 reverted due to leaked subprocess wedge

The INCIDENT-147 fix landed in iter 148's working tree (sidecar
`HOST=::`, `wsProxy` 502 on pre-connect errors, regression tests,
plus a successful live cutover) but **iter 148 was reverted on
wallclock timeout** before the changes were committed.

Root cause of the wedge: during the live-cutover work the agent
ran roughly `FLY_API_TOKEN=… flyctl proxy 5435:5432 -a tex-center-db | tail -5`
via the `Bash` tool. `flyctl proxy` is a long-running tunnel that
never closes its stdout; `tail -5` therefore waited forever for
EOF. The Bash tool call timed out, but the bash subprocess plus
its `flyctl proxy` child kept running. When the agent later emitted
its final "iteration complete" text, the parent `claude -p`
blocked on the still-open pipe to the orphaned subprocess and
couldn't exit. 12 min later the harness's 45-min wallclock hit
SIGKILL, iter 148 was treated as a timeout, the working tree
revert path ran, and the fix was lost.

Surviving artefacts:

- `deploy/INCIDENT-147.md` — diagnosis (committed in iter 147).
- `.autodev/logs/148.md` — record of what 148 implemented and
  live-verified, including image sha and `SIDECAR_IMAGE` roll.
- Live state: the sidecar Machines should currently be running the
  iter-148-deployed image (the agent rolled `SIDECAR_IMAGE` before
  iter 148 was reverted). Verify with `flyctl status -a
  tex-center` and `flyctl status -a tex-center-sidecar`; the image
  sha in 148.md is the reference. Subsequent CD pushes will have
  rebuilt the sidecar though, possibly with the HOST regression
  back in the image.

Two distinct things worth your judgement:

1. **Re-land the iter-148 fix.** Whether to redo it from 148.md's
   description or to also re-verify live (likely yes — we don't
   know whether subsequent CD pushes rebuilt the sidecar without
   the fix). Treat as CRITICAL PATH per current PLAN.

2. **The leaked-subprocess class of wedge.** Any agent Bash call
   to a long-running daemon-style command (`flyctl proxy`,
   `tail -f`, `watch`, `ssh -L`, etc.) will reproduce this. The
   Bash tool timeout reports failure but doesn't kill the
   subprocess tree, so the parent `claude` blocks on exit waiting
   for the pipe to close. Possible mitigations (your call): a
   project convention for proxy-class commands (always
   `&` + explicit `kill` in the same tool call); an
   `engineer.md` rule discouraging them; a harness change to
   `iterate_one.sh` that reaps claude's process group before the
   commit phase. The harness-side change isn't in the agent's
   editable scope (`autodev/` is upstream), so if that's the right
   answer the question is who edits it.

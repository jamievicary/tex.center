# Re: Upstream fix landed for warm-doc body-edit no-op — submodule bump and verify GT-5

Done. M7.4.x closes.

## What was done this iteration (231)

1. **Submodule pointer.** Already at `8c3dec0` in the iter-231
   start commit (`b7aa039`), matching upstream `vendor/supertex`
   HEAD. No bump commit needed — the human-side bump landed
   alongside the start-of-iteration tree.

2. **Local repro now PASS.** Reran
   `tests_gold/lib/test/supertexWarmDocBodyEditNoop.test.mjs`
   against the iter-231 `vendor/supertex` build
   (`vendor/supertex/build/supertex` rebuilt at `8c3dec0`): every
   round emits exactly one `[shipout n=1]` between `rollback k=0`
   and `round-done`. Final line: `PASS — no silent no-op rounds`.
   The silent no-op shape no longer reproduces locally.

3. **Sidecar redeploy.**
   ```
   FLY_API_TOKEN=$(cat creds/fly.token) flyctl deploy \
     --remote-only --no-public-ips \
     -a tex-center-sidecar --config apps/sidecar/fly.toml .
   ```
   New image
   `registry.fly.io/tex-center-sidecar:deployment-01KRHQ3PE6KY61ZD89XMD7P6YB`,
   sha `b10d59ce82cc8ed346f8cb3120625726f6589c14e32df2df163124b6bb042786`.
   Rolling-strategy update of both machines (`d895e7ea479958`
   primary, `683437eb1e3378` standby) cleared cleanly.

4. **`SIDECAR_IMAGE` pinned on control plane.**
   ```
   flyctl secrets set SIDECAR_IMAGE='registry.fly.io/tex-center-sidecar@sha256:b10d59ce82cc8ed346f8cb3120625726f6589c14e32df2df163124b6bb042786' \
     -a tex-center --stage
   flyctl deploy --remote-only -a tex-center
   ```
   New control-plane image
   `registry.fly.io/tex-center:deployment-01KRHQ6ZDCFZFMWGY922VK2QEV`,
   sha `6aa67217b34bd0652bcac4970f1c3162c7c4232fef125ab8081a521a15367801`.
   Machine `e8296d4c2ee398` updated to the new config. Per-project
   sidecar machines minted after this point use the iter-231 sidecar
   image.

5. **GT-5 verification.** Ran `verifyLiveGt5EditUpdatesPreview.spec.ts`
   under the live project against the redeployed stack:
   ```
   ✓  1 [live] › verifyLiveGt5EditUpdatesPreview.spec.ts:52:7
       › live edit updates preview canvas (GT-5)
       › source edit produces a visually distinct preview canvas (4.6s)
   1 passed (43.7s)
   ```
   GT-5 flipped RED → GREEN. The full gold suite runs at the end
   of this iteration via the harness; the harness's `## Test
   summary` block will record whether any other spec regressed.
   Expectation: clean green pass on every spec, since the only
   recent live change is the sidecar image, and that image only
   removes the failure mode GT-5 was pinned to.

6. **PLAN.md.** M7.4.x is now CLOSED. The four-iteration
   229→230→231→close narrative compressed to a closed-milestone
   paragraph pointing at the local repro
   (`tests_gold/lib/test/supertexWarmDocBodyEditNoop.test.mjs`)
   and the live spec (`verifyLiveGt5EditUpdatesPreview.spec.ts`)
   as the retained regression locks. Live focus returns to GT-6
   (slow `.cm-content` appearance) as the next open RED.

## Diagnostic seam status

Iter 228 added the `CompileSuccess.noopReason` field and the
`compile no-op (no pdf-segment shipped)` warn log line in
`apps/sidecar/src/server.ts`. The question asks to keep it in
place "until GT-5 has been green for several runs". Plan: keep
the seam for now, schedule its removal as a one-iteration
janitorial slice after the next 2–3 full gold passes confirm
GT-5 stays green. Tracking via a one-line entry in
`FUTURE_IDEAS.md`.

## No follow-ups outstanding

If GT-5 regresses on a subsequent gold pass, the seam log line
will still surface the round shape, the local repro will pin the
new failing input, and we're back to the same playbook as iter
229. But there is no in-progress investigation to leave dangling.

# Pivot: the live product is broken; stop nibbling

## What the user is actually seeing on https://tex.center

1. Login: ✅ works.
2. Project list / create-project / open-project: ✅ works (sign of
   page-level routing + DB + cookie auth).
3. Editor renders three panes (file tree / CodeMirror / PDF preview
   placeholder): ✅ visually.
4. **Edit a file → no save happens, no way to save.**
5. **Cannot create new files** (the UI button does nothing visible).
6. **PDF preview never appears**, no matter what's typed.

All three failures (4, 5, 6) share one most-plausible cause: the
**WebSocket from browser → control plane proxy → sidecar is not
working in production**. Yjs auto-syncs over the WS (there is no
save button by design); the file-tree CRUD verbs route through the
WS; the compile + PDF segments come back over the WS. No working
WS = exactly these three symptoms. Verify this is the cause before
fixing anything, but treat WS connectivity as the load-bearing
investigation target.

## Why we're here

Iter 137 wrote `verifyLiveFullPipeline.spec.ts` (M8.pw.4) — the
spec specifically designed to catch "the product doesn't work" —
and then marked the milestone `[~]` and moved on. The activation
(test OAuth client provisioning, `TEXCENTER_FULL_PIPELINE=1`
toggle, first run against live) is gated on an "operator-set"
flag and **has never been run**. So the test exists, isn't run,
and the regression it would have caught has been live the entire
time.

This is the iter-76 pattern repeating for the third time:
**writing tests that don't get activated.** The previous two
times cost a production-down OAuth bug each. This time it's
costing the entire product loop.

Worse: iter 139's "Notes for future iterations" pointed the next
ordinary iteration at **M7.4.2 — upstream supertex daemon
serialise/restore wire** (checkpoint persistence for cold-start
UX). That work has no bearing on whether save/create/preview
function today. Iter 140 then burned a slot deleting 20 lines of
dead `makeSessionAuthoriser` code because `N % 10 == 0` triggered
the scheduled refactor cron. The cron-triggered rituals
(refactor every 10, plan-review every 11) **must pause** while
the live product is non-functional. Resume them when the live
acceptance probes from M8.pw.4 pass.

## What this iteration does

Treat the broken live product as a P0 incident — same posture as
iters 76, 129, 131. Concrete sequence (don't bundle, but don't
stall on cosmetic gates either; the diagnostic steps below are
one iter's-worth of work and the fix should follow in the
next):

### 1. Activate M8.pw.4 against the live deployment NOW

This is the one-time operator setup the project has been
deferring. Do all of it this iteration:

- Provision a dedicated test OAuth client in the Google Cloud
  Console for the `tex.center` GCP project (separate from the
  prod client; redirect URIs include
  `http://localhost:3000/auth/google/callback` and
  whatever the M8.pw.3.2 script needs).
- Run `scripts/google-refresh-token.mjs` to obtain the refresh
  token for the test client; store under `creds/` per existing
  conventions, gitignored.
- Push the necessary live secrets (`TEST_OAUTH_BYPASS_KEY` if
  not already, `GOOGLE_TEST_*` env vars per
  M8.pw.3 design) via `flyctl secrets set`.
- Run `TEXCENTER_FULL_PIPELINE=1 TEXCENTER_LIVE_TESTS=1 pnpm
  --filter tests_gold playwright test verifyLiveFullPipeline.spec.ts`.
- **Read the failure mode.** This spec will fail today. The
  failure mode is the diagnosis.

If the spec fails at the "wait for `pdf-segment` frame within
240 s" step, the WS is hung or the compile isn't firing. If it
fails earlier (no WS upgrade succeeds at all, or
`waitForWebSocket` never fires), the WS routing is broken. The
failure pinpoints the layer.

### 2. Diagnose the WS connection live

In parallel or alongside step 1, do direct probes:

- `flyctl logs --no-tail -a tex-center` and
  `flyctl logs --no-tail -a tex-center-sidecar` while
  the user-flow is in progress (you'll have to coordinate with
  the user OR drive yourself via Playwright). Capture the
  control plane's WS upgrade attempt, whether it forwards
  upstream, whether the sidecar receives anything.
- `wscat -c "wss://tex.center/ws/project/<known-id>" -H "Cookie: tc_session=<minted>"`
  from a local box (or curl WS upgrade) to confirm the upgrade
  itself succeeds with a real session cookie. Use
  `tests_gold/lib/mintSession.ts` against a flyctl-proxied
  Postgres to mint a valid live cookie.
- If the upgrade succeeds but no frames flow, the issue is
  sidecar-side: machine waking, Yjs init, or compile path.
- If the upgrade fails with 403, suspect M7.2's access gate —
  specifically whether projects the user creates today have
  `owner_id` matching their session's user_id, and whether
  iter 131's user-row UPDATE somehow detached the linkage.
- If the upgrade fails with anything else (502, timeout, 401),
  it's upstream routing or auth.

### 3. Fix the root cause; do not paper over

Same posture as iters 129/131: identify the actual broken
component, fix it, write a regression test that proves it stays
fixed, redeploy and re-run `verifyLiveFullPipeline.spec.ts`
until it passes end-to-end. Don't ship a "make symptoms go
away" workaround.

### 4. Wire M8.pw.4 into deploy-verification as a hard gate

After it passes once, ensure the deploy workflow runs it on
every push (or at minimum on every push that touches the
`apps/` or `packages/` trees). The "operator-gated activation"
framing must end — automatic execution is the only thing that
prevents this class of regression.

## On PLAN.md (separate this-iter task)

Once the live fix is in, PLAN.md needs a rewrite. The user's
words: "full of old stuff, and fails to give a strong pathway
to a full and functional MVP." 306 lines is too long and reads
as a status diary, not a roadmap.

What PLAN.md should be:

- ~80 lines max.
- Top section: a 5-line "critical path to MVP" listing the
  remaining work in execution order, each item a one-liner with
  the iter it's expected to take.
- Middle section: per-area state (auth / sidecar / persistence /
  acceptance) in 1-2 lines each — current state, what's next.
- Bottom section: "open questions" — known gaps, deferred
  decisions. No history.

Closed milestones go into a single "completed" line listing
their IDs — the git log is the actual history.

Tackle this as the iteration *after* the live fix lands. Don't
bundle.

## What to pause

- The N%10 / N%11 cron-triggered refactor/plan-review iterations.
  Resume only when `verifyLiveFullPipeline.spec.ts` passes
  against live, automatically, on every deploy.
- M7.4.2 (upstream supertex daemon serialise/restore wire) and
  all M7.5.x daemon adoption work past what already shipped.
- FUTURE_IDEAS-sourced slices.
- Any further M7.x hardening (rate limits, observability, etc).

Everything in this list is real engineering work but not on the
path to "user can edit a project, see PDF update, sign out, come
back, edit again". That path is the MVP. Nothing else.

## What success looks like

When this iteration's work is done, the user will be able to:

1. Click into an existing project at https://tex.center/editor/<id>.
2. Type into the editor; the file save automatically over WS.
3. Click the create-file button; a new file appears in the tree.
4. Type a minimal LaTeX document; within ~10 seconds a PDF
   renders in the right panel.
5. Refresh the browser; the edits are still there.

`verifyLiveFullPipeline.spec.ts` should be the test that
asserts all five points pass on every deploy. Until they all
do, no other engineering work proceeds.

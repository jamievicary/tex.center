# Answer — iter 150

## 1. Re-land iter-148 fix

**Already done in iter 149.** The question was written before
iter 149's commit landed; it's now in tree at `09c2ea6`:

- `apps/sidecar/src/index.ts` — `DEFAULT_BIND_HOST = "::"`,
  `resolveBindHost(env)` helper with empty-string clamp.
- `apps/sidecar/Dockerfile` — runtime `HOST=::`.
- Regression locks: `apps/sidecar/test/bindHost.test.mjs`,
  `tests_normal/cases/test_sidecar_dockerfile.py`
  (`test_runtime_listens_on_all_interfaces` flipped),
  `tests_normal/cases/test_node_suites.py::test_sidecar_bind_host`.
- `apps/web/src/lib/server/wsProxy.ts` — pre-connect 502 write,
  `apps/web/test/wsProxy.test.mjs` Case 4 asserts the 502.

PLAN was renumbered: 148 reverted, 149 re-landed code, **150 = live
cutover**, 151 = M8.pw.4 activation. So the answer to "redo from
148.md or re-verify live too?" — neither/both:

- Code-side: **don't redo**, it's in tree. Iter 149's tests pass.
- Live: **must re-verify**, but as a separate iteration. The
  live state recorded in 148.md may or may not survive subsequent
  CD pushes — `apps/sidecar/**` is in the deploy-sidecar workflow's
  path filter, so the iter-149 merge will itself have triggered a
  fresh image build at a new sha, and `SIDECAR_IMAGE` on
  `tex-center` is still pinned to whichever sha was last rolled.
  The new image *should* contain `HOST=::` (the Dockerfile change
  is in tree), so the cutover sequence is the same as iter 148's:
  roll `SIDECAR_IMAGE` to the post-149 sha, destroy stale
  per-project Machines, probe.

I am **not** doing the live cutover in this iteration — see §2.
PLAN already schedules it for iter 150, but this iteration is
consumed by the discussion. **Iter 151 takes the cutover; iter
152 takes M8.pw.4 activation.** PLAN updated below.

## 2. Leaked-subprocess class of wedge

This is the more interesting half of the question and worth
treating as a class, not an incident.

### What actually happened (mechanics)

`flyctl proxy 5435:5432 -a tex-center-db | tail -5` is a pipeline
where the *left* side never closes stdout and the *right* side
blocks on EOF. The Bash tool's per-call timeout cancels the
*tool call* — the tool reports failure to the model — but the
child `bash -c '…'` and its `flyctl proxy` grandchild remain in
the agent's process group, both holding fds to the pipe and to
the tool's stdout-capture pipe.

When the agent later emits its terminal message, `claude -p`
tries to flush + close. The tool-output capture pipe is still
held open by the orphaned grandchildren, so the parent's exit
path blocks on `waitpid`/`close` of those fds. From the outside
this looks like "agent hung after writing 'iteration complete'."
SIGKILL from the 45-min wallclock is the only thing that breaks
it, and the iteration is then treated as a timeout → reverted.

This is the same shape as the `ScheduleWakeup`/`Monitor` wedge
already called out in `autodev/engineer.md` §3 (don't poll a
background `run_in_background:true` task). What's new is that
*synchronous* Bash calls also wedge if the subprocess is the
daemon kind — `flyctl proxy`, `flyctl logs -f`, `tail -f`,
`watch`, `ssh -L`, `kubectl port-forward`, `pnpm dev`, anything
streaming.

### Who should fix it

Three layers, picking the smallest sufficient one:

1. **Agent-side convention (this answer's commitment).** Never
   invoke a daemon-style command from Bash without one of:
   - explicit `timeout Ns …` wrapper that *kills* on expiry
     (`timeout --kill-after=2 10 flyctl proxy …`), or
   - `run_in_background:true` + an explicit kill in a paired
     Bash call before iteration end (`kill -TERM -- -$PID` and
     a `wait`), or
   - redirecting both stdin and stdout so nothing is pipelined
     waiting for EOF (`flyctl proxy … >/tmp/proxy.log 2>&1 &
     PROXY_PID=$!; …; kill $PROXY_PID; wait $PROXY_PID || true`).

   In practice the cutover step that wedged 148 doesn't need
   `flyctl proxy` at all — the cutover is `flyctl secrets set` +
   `flyctl machines list/destroy` + probing the public ingress,
   none of which open tunnels. The bad invocation in 148 was
   exploratory ("can I read DB?"); the lesson is to not reach for
   tunnel-class commands as a debugging shortcut.

2. **`engineer.md` rule.** I can't edit `autodev/engineer.md` —
   it's upstream framework code. Recommend the user add a clause
   to the §3 "Wallclock" / resource-hygiene section forbidding
   pipelines into daemon-style commands. Text suggestion:

   > Never pipe a long-running command into a downstream that
   > waits for EOF (`flyctl proxy | tail -N`, `tail -f | grep`,
   > `pnpm dev | head`). The pipeline never closes, the Bash
   > timeout reports failure but doesn't kill the subprocess
   > tree, and the iteration cannot exit. Wrap in `timeout` (with
   > `--kill-after`) or use `run_in_background:true` with a
   > paired explicit kill.

3. **Harness-side change.** `iterate_one.sh` could reap the
   agent's process group before the commit phase
   (`kill -TERM -- -$AGENT_PGID`, brief wait, then `kill -KILL`).
   This is the only mitigation that doesn't depend on the agent
   doing the right thing every time, but it's outside agent
   editable scope. **Recommend the user apply it** — it's
   strictly defence-in-depth even if the convention in (1) is
   followed, and it would have saved iter 148. Sketch:

   ```sh
   # iterate_one.sh, after claude -p returns
   pgid=$(ps -o pgid= -p $CLAUDE_PID | tr -d ' ' || true)
   if [ -n "$pgid" ]; then
     pkill -TERM -g "$pgid" 2>/dev/null || true
     sleep 1
     pkill -KILL -g "$pgid" 2>/dev/null || true
   fi
   ```

   (Exact form depends on how `claude -p` is currently spawned;
   `setsid` may be needed to guarantee a distinct pgid.)

My judgment: **do all three.** (1) is cheap and the most
effective ex ante. (2) makes the rule durable across model
generations. (3) is the only one that survives an agent that
ignores (1) and (2).

### Probe-script side-effect

`scripts/probe-live-ws.mjs` is a one-shot — it dials, asserts,
exits. That's fine. No change needed there.

## 3. PLAN updates

- Iter 150 (this) — discussion mode; no engineering.
- Iter 151 — live cutover (the work previously planned for 150).
- Iter 152 — M8.pw.4 activation (the work previously planned for
  151).
- FREEZE-lift gate moves to iter 152.

`.autodev/PLAN.md` edited in this iteration to reflect the
renumber + capture the leaked-subprocess convention as a Known
Follow-up (so iter 151 picks it up without re-reading this
answer).

## 4. Commitments

- Iter 151 will use only `timeout`-wrapped or short-lived
  `flyctl` calls (no `flyctl proxy`, no `flyctl logs -f`, no
  `tail -f`-style pipelines).
- Iter 151's pre-flight: `flyctl image show -a tex-center-sidecar`
  (one-shot) to fetch the post-149 sha; if that sha differs from
  the one currently pinned in `SIDECAR_IMAGE`, roll it.
- Iter 151 will NOT open a Postgres tunnel for any reason. DB
  inspection is not on the cutover path.

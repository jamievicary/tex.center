# Live diagnostic — compile runs but emits zero pdf-segments. M20.3 hypothesis was wrong.

Manual debug-toast capture from tex.center, opening an **existing**
project (Machine was in stopped state on connect):

**On project select (chronological order):**
```
hello proto=1
file-list (1)
compile-status running
0.0s — compile-status idle
```

**On edit:**
```
Yjs op 24B                       (outgoing doc-update)
compile-status running
2.7s — compile-status idle
```

In neither case does a `pdf-segment` toast appear. So:

- WS upgrade ✓
- Sidecar handshake ✓ (hello + file-list)
- Compile fires ✓
- **Compile completes in plausible time (2.7 s on edit) but ships zero segments.**

This **invalidates the suspend-stage-race hypothesis** the last
~10 iterations (340/342/343) have been pursuing. The Machine wakes
fine; the daemon is responsive. The bug is downstream — somewhere
between "lualatex ran" and "`pdf-segment` reaches the wire".

## Prime hypothesis

`{ok: true, segments: []}` is the canonical no-op signature in
`supertexDaemonCompiler` (the rollback path with no shipouts, per
iter-189 / `apps/sidecar/src/compiler/supertexDaemon.ts:166`). A
2.7 s compile that emits zero segments strongly suggests the
daemon ran the round but saw **no change since the previous
compile** — so it correctly reported "no shipout".

If your **Yjs op lands in the in-memory Y.Doc but never reaches
the on-disk `main.tex`** the daemon spawns its kpathsea against,
the daemon would compile **stale content** identical to the prior
round → no-op → zero segments. **Every user edit would look
broken in exactly the pattern observed.**

Concrete suspect: M23's mirroring pattern. M23.5 (iter 316) added
per-file `Y.Text.observe` mirrors for **non-main** files. Confirm
the **main.tex live-edit path** still writes to disk on every Yjs
update — is `workspace.writeMain(source)` called from a Y.Text
observer on the main doc, or only from a top-of-compile hook
that's somehow being skipped on the cold-resume path?

The 0.0 s `compile-status idle` immediately on project select is
also consistent: the daemon's `ensureReady()` first-compile runs
before any source has been mirrored to disk → empty workspace →
no shipout. Confirm `awaitHydrated()` actually waits for `main.tex`
to be on disk before unblocking the initial compile.

## What to do

1. **Add a server-side diagnostic toast** (or a server log
   surfaced as a debug-toast) that records, immediately before the
   daemon's `recompile,…` write, the **first 80 bytes of the
   on-disk `main.tex` file** the daemon will compile. Compare
   against the in-memory `Y.Text.toString().slice(0, 80)`. If they
   differ, the bug is in the mirroring.
2. **If they match** but the daemon still no-ops, the bug is in
   the daemon's change-detection or shipout path — different
   investigation.
3. **Roll back / disable the M23.5 observer mirror as a stopgap**
   to test whether reverting that path restores PDF emission. If it
   does, the bug is in the observer plumbing for main.tex.

## Stopgap please

Independently of root-cause: **disable the Machine idle-stop
entirely** (set `SIDECAR_STOP_MS` to a very large value, or
short-circuit `stopStage.arm` to a no-op) so my existing projects
become usable on the live deploy while the proper fix is being
worked out. A Fly bill increase is fine; the site being unusable
for existing projects is not.

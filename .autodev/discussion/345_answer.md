# Agreed — WS-frame timeline dump becomes a default fixture

Strong yes on the proposal. The diagnostic gap it patches is real,
the cost is small, and `captureFrames` is already 80 % of the data
collection. I want to land it, with two calibrations:

1. The "this would have caught it in iter 334" framing is partly
   hindsight (see §A below).
2. The implementation has one mildly tricky bit around the projectId
   binding — laying it out so the next iteration's author doesn't
   re-invent it (§B).

## §A — Calibration on the "we'd have re-oriented instantly" claim

Two distinct bugs were under investigation across iter 334–344:

- **Bug A** (data loss on viewer disconnect) — what GT-9 was
  actually pinning. GT-9 *did* receive pdf-segment frames; the
  failure shape was a truncated rehydrated source, not zero
  segments. A WS-timeline dump of GT-9 would have shown
  `pdf-segment×2, compile-status running→idle×2, doc-update×N`
  — i.e. it looks like a healthy compile chain. The
  truncation-on-persist mechanism is invisible from the client
  WS; it lives in the server-side debounce/cancel interaction.
- **Bug B** (zero pdf-segments on cold-resume edit) — your
  manual repro. **This** is the one a timeline dump catches
  immediately, because the discriminating signal IS in the WS
  stream (compile-status cycles with zero pdf-segment between).
  But Bug B isn't reproduced by any current spec, including
  GT-9. A timeline dump of GT-9 wouldn't have surfaced it
  because GT-9 doesn't exercise the cold-resume-after-stop path
  that Bug B requires.

So the methodology benefit is genuine, but the specific
counterfactual is weaker than "five days of debugging avoided".
The fair version: had I been running a fleet of live specs against
a stopped-project-with-prior-edits scenario with timeline dumps on,
**I'd have seen Bug B independently of GT-9** the first time it
fired. That's still a strong reason to land the proposal — Bug B
deserves its own spec (`verifyLiveGtNStoppedReopenEmitsSegment`,
say), and the timeline dump makes that spec self-diagnostic from
day one.

The deeper observation behind the proposal is correct and holds:
**the gold suite's failure mode signal-to-noise is dominated by
browser-level assertions ("`.cm-content` visible") that translate
back into "something somewhere went wrong" rather than "the WS
emitted X then Y then nothing".** That's the right thing to fix
regardless of which specific bug it pre-empts next.

## §B — Implementation plan

The mechanism in your proposal is right; one design wrinkle is
the projectId binding. `captureFrames(page, projectId)` is called
explicitly today because it filters on a known URL substring. To
promote it to a default fixture (your proposal's §"What about
specs that don't use captureFrames today?"), the fixture needs
either:

- **(a)** to know the projectId in advance — feasible only for
  specs that consume the `liveProject` / `sharedLiveProject`
  fixtures, which is the majority but not all (e.g.
  `verifyLiveAuthed.spec.ts`, `verifyLive.spec.ts`,
  `verifyLiveDeleteProject.spec.ts` don't); or
- **(b)** to sniff the projectId from the first `/ws/project/<id>`
  URL the page opens, and start bucketing all such WS connections
  the page makes thereafter.

(b) is cleaner and is what I'll do. The fixture's `page.on("websocket")`
listener can match `/ws/project/([0-9a-f-]{36})/` (or the
authoritative regex) lazily, bucket per-id internally, and the
`dumpTimeline(specName)` method emits one block per id seen. For
specs that don't open any project WS, the dump is a single line
("no project WS observed"), keeping the output uniform.

Concrete plan:

1. Extend `fixtures/wireFrames.ts`:
   - Add per-frame timestamps (relative to capture start) and a
     `dumpTimeline(specName)` method that emits the format from
     your §Proposal block.
   - Keep the existing return shape (`pdfSegmentFrames`,
     `overlapErrors`, `docUpdateSent`, `compileStatusEvents`)
     fully backward-compatible — the 5 current consumers don't
     change.
   - Surface outgoing TAG_DOC_UPDATE frames in the timeline (not
     just the running counter); useful for "client typed but the
     op got ack-dropped" diagnosis.
2. Create `fixtures/wireFramesAutoFixture.ts` — a thin
   Playwright fixture wrapping `captureFrames` with the
   sniff-projectId-from-URL variant. Export it as part of the
   `sharedLiveProject` test object so it auto-runs for every
   live spec that imports from there. (The 3 specs that don't
   use `sharedLiveProject`/`liveProject` —
   `verifyLiveAuthed`, `verifyLive`, `verifyLiveDeleteProject`
   — can be migrated in a small follow-up; not load-bearing.)
3. Wire `test.afterEach` into the fixture to call
   `dumpTimeline(testInfo.title)`, gating on the
   `TEXCENTER_DUMP_WIRE_TIMELINE` env var. Default on in the
   local iter-state harness (the gold runner sets it); off in any
   future hosted CI runner.
4. Keep the dump format compact and grep-friendly:

   ```
   [<spec-title>] timeline (project=<id>):
     +<elapsed>s  <DIR>  <TAG>  <terse-summary>
     ...
   [<spec-title>] summary: in {hello×N, file-list×N, compile-status×N (cycles=K, mean-cycle=Xs, zero-segment-cycles=Z), pdf-segment×N (total-bytes=B)}, out {doc-update×N (total-bytes=B), file-ops×N}
   ```

   The `zero-segment-cycles` derived stat is the exact thing
   that would have pinned Bug B: a non-zero value means at least
   one compile-status running→idle cycle shipped no pdf-segment.
   Grep-pinnable across an entire gold pass.

5. (Stretch) Once landed, add a `verifyLiveGtNStoppedReopenEmitsSegment`
   spec that opens a stopped project with prior persisted edits,
   types one character, and asserts `zero-segment-cycles===0`.
   This is the spec that pins Bug B once Bug B is understood; the
   timeline dump makes it self-diagnostic on RED.

## §C — Sequencing

Iter 346 (this iter, discussion mode): this answer.

Iter 347: Bug B investigation per `344_answer.md`'s existing
commitment — capture daemon transcript from prod and decide root
cause. Bug B is user-impacting and a real outage symptom; it
takes priority over the diagnostic-tooling work.

Iter 348: land §B steps 1–4 (the diagnostic infra). Step 5 (the
new Bug B spec) waits until Bug B's root cause is known so the
spec asserts on the right invariant.

This means the diagnostic surface won't be in place for the iter-347
Bug B repro — that one still leans on `flyctl logs` + the existing
`compileStatusEvents` field that 3 specs already consume. Acceptable:
the timeline dump's primary value is pre-empting *future* mystery
bugs, not the one we already have a forward plan for.

## §D — PLAN.md changes

Adding to the priority queue, after Bug B:

> **WS-frame timeline as default fixture.** Promote
> `fixtures/wireFrames.ts` from helper to default fixture on the
> `live` project; dump per-test timeline on success and failure
> to `tests_gold/state/last_gold_output.txt`. Discussion:
> `.autodev/discussion/345_question.md` /
> `.autodev/discussion/345_answer.md`. Implementation §B steps
> 1–4; step 5 (Bug B spec) follows the Bug B fix.

# Re: Toast UX + debug mode + compile-cycle telemetry

Agreed: thematically coherent batch, all in the editor/toast surface.
Working through each point with a decision, then noting where I push
back. Implementation lands across the next 1–2 iterations as
**M22.4** (a new milestone slice — see updated PLAN.md). Code does
**not** land in this iteration: the bundle touches eight files
including a wire-protocol shape decision (point 8) that benefits
from being recorded before I cut.

---

## 1. Debug toggle in settings popover — agreed

Add a `debugMode` field to `EditorSettings` (next to `fadeMs`). The
popover gets a checkbox row above the slider. URL `?debug=1/0` and
Ctrl+Shift+D continue to write the same persisted setting (i.e. all
three surfaces converge on a single source of truth). Today's
`localStorage["debug"]` key is migrated into
`localStorage["editor-settings"].debugMode`; the old key is read
once on first load to preserve current users' explicit-off
preference, then deleted.

## 2. Debug-on-by-default — agreed, with the migration above

`DEFAULT_SETTINGS.debugMode = true`. Persisted state wins:
`parseSettings` returns the persisted value when present, otherwise
falls back to the default. Combined with the migration in (1),
existing users who set `localStorage["debug"]="0"` keep it off; new
visitors and existing users who never touched the toggle see toasts.

## 3. Default cross-fade 1000 ms — agreed

`FADE_MS_DEFAULT: 180 → 1000`. Confirm this is the *default*, not
the slider max — slider stays 0–3000 ms. Anyone who already moved
the slider keeps their value.

## 4. Animate toast vertical movement — agreed

Svelte 5's `animate:flip` directive on the keyed each block is the
right primitive here: it measures rest position pre-update and
animates the delta post-update. No hand-rolled FLIP. One line in
`Toasts.svelte`, no store change.

## 5. Slow descent — agreed, **500 ms cubic ease-out**

Picking a single value rather than asking back: `{ duration: 500,
easing: cubicOut }`. Midpoint of your 400–600 ms range; cubic-out
matches the "deliberate, decelerating to rest" feel and is the
standard easing for entry/move motion. Tunable later via a
constant if it feels wrong.

## 6. Longer toast lifetime — agreed, scoped

You said "10 seconds for the default category" then "at least to
the debug-* categories". I'll set **all debug-\* TTLs to 10 s**
(was 2 s for blue/green/orange/grey, 4 s for red). The user-facing
info/success/error stay where they are: info 5 s, success 3 s,
error 6 s — those are user-attention surfaces with different
ergonomics and a 10 s success toast is annoying. If you disagree
on info, easy to bump separately.

Aggregation behaviour preserved (the 500 ms `AGGREGATE_WINDOW_MS`
is independent of TTL; long TTL just means each toast lingers
longer after the burst settles).

## 7. Compile-cycle telemetry — agreed, but the spec is slightly off

Current reality of the wire: a compile round emits exactly **one**
`pdf-segment` per round, not "one or more". The shape is:

```
compile-status running  →  [0 or 1] pdf-segment  →  compile-status idle
```

Zero segments when the round is a no-op (round-done with no
`[N.out]` events — see `apps/sidecar/src/compiler/supertexDaemon.ts:166`).
One segment otherwise. So in practice the telemetry will read:

```
0.0s — compile-status running
1.7s — pdf-segment [3.out] 3652 bytes
4.6s — compile-status idle
```

Mechanism: a `CompileCycleTracker` keyed on the `running` →
`idle`/`error` cycle, captured in `apps/web/src/lib/compileCycleTracker.ts`
(pure, unit-testable, injectable clock). The tracker hands an
`elapsedMs` to `debugEventToToast` via a wrapping function. Reset
on every `running` event so cycle N+1 doesn't inherit cycle N's
start. Also reset on a fresh `pdf-segment` outside a known cycle
(defensive — shouldn't happen, but the wire doesn't strictly
guarantee `running` always precedes a segment).

## 8. `pdf-segment` toast: bytes + page name — agreed, with a wire change

The `bytes` half is free (already on `WsDebugEvent.pdf-segment`).

The `[3.out]` half requires plumbing the shipout page through the
wire frame. Today the sidecar already knows `events.maxShipout`
per round (`supertexDaemon.ts:177`) and ships it as the optional
`shipoutPage` on `CompileSuccess` — but that field never reaches
the client; only the segment bytes do.

**Decision: add `shipoutPage` to the wire `pdf-segment` frame.**
Two encoding options:

- **(A) Extend the 12-byte segment header → 16 bytes**, adding a
  `uint32` for `shipoutPage` (0 = unknown / sentinel). Lowest
  framing overhead, breaks any older client mid-rollout —
  acceptable because the deployed clients are SvelteKit-built and
  shipped together with the sidecar via the same Fly deploy. **Pick
  this.**
- (B) Send a separate `compile-progress { shipoutPage }` control
  message before the segment. Avoids a binary-framing bump but
  doubles the small-frame count and couples two frames the client
  must correlate. Rejected as more complexity for less benefit.

Per-page chunk naming: supertex uses `[N.out]` (see the daemon
protocol regex `/^\[(\d+)\.out\]$/` in
`apps/sidecar/src/compiler/daemonProtocol.ts:28`). Toast text shows
exactly that: `pdf-segment [3.out] 3652 bytes`.

Wire change scope:

- `packages/protocol/src/index.ts`: `PdfSegment` gains
  `shipoutPage?: number` (encoded as `uint32`, 0 sentinel). Header
  grows from 13 → 17 bytes total (tag + 4×4). `encodePdfSegment` /
  `decodeFrame` updated; existing codec tests updated.
- `apps/sidecar/src/server.ts:544`: pass `seg.shipoutPage =
  result.shipoutPage` before encoding (zero hop — the compile
  result already has it, we just thread it onto the segment).
- `apps/sidecar/src/compiler/supertexDaemon.ts:177`: stamp the
  segment with `shipoutPage: events.maxShipout`.
- `WsDebugEvent.pdf-segment` carries `shipoutPage`;
  `debugEventToToast` formats `pdf-segment [${shipoutPage}.out] ${bytes} bytes`,
  falling back to `pdf-segment ${bytes} bytes` when 0/missing.

## 9. `compile-status idle` toast with elapsed time — agreed

Same `CompileCycleTracker`. Toast text: `compile-status idle`
prefixed by `${elapsed}s — ` (matching your sample). Error variant
likewise: `${elapsed}s — compile-status error: <detail>`.

---

## Scope / sequencing decision

The bundle is coherent but not tiny: it touches `settingsStore`,
`Settings.svelte`, `debugToasts.ts`, `toastStore.ts`, `Toasts.svelte`,
the new `compileCycleTracker.ts`, `wsClient.ts`, `wireFormat` on
the protocol, the sidecar segment encoder, plus locks. That's
~9 source files + matching unit-test files, with one wire
breaking-change.

Plan: **M22.4 split into two coherent iterations**, each
green-on-its-own:

- **M22.4a** (UI-only — no wire change): items 1, 2, 3, 4, 5, 6,
  plus a stub `CompileCycleTracker` that adds elapsed prefixes to
  `compile-status` toasts (item 9). `pdf-segment` still shows
  `${bytes}B` only — page name lands in M22.4b. This iteration is
  ~6 files, no protocol package touched, easy revert if the FLIP
  animation regresses.
- **M22.4b** (wire change): items 7-as-completed, 8.
  `PdfSegment.shipoutPage` plumbing across protocol + sidecar +
  client. Updates `debugEventToToast` for `pdf-segment` and wires
  the tracker's `elapsedMs` into the segment toast too.

If 4a + 4b land back-to-back this is effectively "one human-visible
ship" but mechanically two safe iterations.

---

## Follow-ups committed

- PLAN.md updated: new **M22.4 (split a/b)** under M22.debug-toasts.b.
- Default cross-fade 180 → 1000 noted as user-facing UX change.
- Old `localStorage["debug"]` migration documented as a one-shot
  read-then-delete in `initDebugFlag` (or its replacement).

## Open questions back to you (none blocking)

- Info-toast TTL: leave at 5 s, or bump? Default-answer: leave.
- Animation duration 500 ms (midpoint of your range): OK?
  Default-answer: yes; tunable later.
- Wire-format choice (A vs B) for shipout page: I'm picking (A).
  Default-answer: confirmed unless you flag.

I'm not blocking on any of these — proceeding with the defaults.

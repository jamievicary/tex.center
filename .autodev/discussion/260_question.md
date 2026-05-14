# New priorities — promote these into PLAN.md and sequence

I have exercised live v260 and want the following work to be
the priorities, in PLAN.md. For each, follow the
pin-first-then-fix protocol where it applies (smoke-test the
pin RED on live before promoting it; do not bundle a fix in the
same iteration as its pin unless the pin already fails on live).

## 1. Centred project title in the editor title bar

When in edit mode (`/editor/<id>`), the project title should
appear **centred at the top of the title bar**. Currently the
title is not visible there (or not in the expected position).
Add as a small UI slice — pin with a local Playwright spec that
checks the title is in DOM, centred, and matches the project's
`name`. Should be the cheapest item in this list.

## 2. Cold project loads are STILL 20 s+

I am still seeing 20 s+ load times when opening a project that
has not been opened for a while. Concretely: my project named
`ererg`, opened after a period of inactivity, takes well over
20 s to become usable.

This contradicts the iter-260 green status of
`verifyLiveGt6LiveEditableState` (which reports
`cmContentReadyMs=857`, `keystrokeAckMs=17`). So either:

- The test is not actually exercising a COLD project. Audit
  `verifyLiveGt6LiveEditableState.spec.ts`: does it verify the
  per-project Machine is genuinely in the `suspended` (or
  `stopped` / non-existent) state **before** the dashboard
  click? If the Machine is already `started` because of recent
  setup work, the test is meaningless.
- The Fly Machine for `ererg` ends up in a state other than
  `suspended` (e.g. `stopped` because `auto_destroy:false` was
  set late or didn't apply to old Machines; or destroyed
  entirely by the orphan-sweep because the timing was wrong;
  or never suspended in the first place because the sidecar
  idle handler hit the fallback `exit(0)` path).

Investigate concretely. Inspect the live Fly state of the
`ererg` project's Machine. Pull `flyctl logs` from the
suspend/resume cycle. Find the gap between "test green" and
"user reality red".

The acceptance criterion is unchanged: **fully-live within
1000 ms on cold access, robustly**. The test needs to
actually pin that, against a verified-cold Machine state.

## 3. Multi-page PDF preview — only page 1 ever shows

Raised in iter 241 (`241_question.md`) — still not addressed.
The PDF preview pane only ever shows page 1 of the compiled
document, even for documents with multiple pages. Pin with a
gold test that drives a project whose body produces ≥ 3 pages
and asserts page 2+ are visible in the preview pane (either
≥ 2 canvas elements, or one canvas of total height > one page,
or pagination affordance present). Then diagnose: wire format
`totalLength` cap, preview canvas component rendering only
first segment, or something else. Iter 242's `241_answer.md`
ranked three hypotheses — start from there.

## 4. Rich file picker on the left

The current file picker is the flat `M11.1` precursor and is
insufficient. I want a **rich tree widget** with:

- Collapsible directories.
- Drag-and-drop **files from desktop into the picker** (upload).
- Drag-and-drop **files from picker out to desktop** (download).
- Intra-tree drag-and-drop (rename across folders) — already in
  the PLAN as M11.4.

**Ideally use a high-quality library widget** rather than
writing a tree from scratch. The PLAN currently says "Native
Svelte 5 component (no React island, no third-party tree lib)".
**Revisit that constraint.** I would rather lean on a
well-maintained widget (e.g. headless tree primitives, or a
Svelte-native one) than carry the maintenance burden of a
bespoke tree. Survey current options, recommend one, and
update the M11 milestone to reflect the chosen approach.

OS-drop upload (M11.5) is currently blocked by FUTURE_IDEAS
"binary asset upload". The full picker needs that unblocked.
Sequence: pick the library → land M11.1/2/3 against it → land
binary-asset wire (unblocks M11.5) → land M11.4/5.

## 5. Writerly visual aesthetic

I want to retune the site CSS to a **subtle "writerly"
aesthetic** — restrained typography (a serif body face or a
quietly distinctive sans; not the default system stack),
generous line-height, gentle off-white backgrounds rather than
flat white, narrow content columns where appropriate, no
ornament. The current look is functional but feels like a dev
tool, not an editor for serious writing.

Propose a small palette and type pair, then apply consistently
across the landing page, dashboard, and editor chrome. The
editor pane itself (CodeMirror + PDF preview) should remain
strictly functional — the aesthetic change is for the chrome,
not the content surfaces.

Pin with a local Playwright spec that screenshots the landing
page and the dashboard and uses Playwright's visual-snapshot
diff to lock the chosen aesthetic.

## What this iteration should produce

This is a **discussion-mode iteration**:

1. Update PLAN.md to promote items 1–5 above into named
   milestones / slices, sequenced relative to each other and
   relative to the existing open work.
2. For item 2 (cold-load latency): audit the existing GT-6
   live-editable spec and name what it actually verifies vs.
   what the user-reported bug requires. If the spec is not
   exercising a verified-cold Machine, that is itself the bug
   and must be pinned by a stronger spec next iteration.
3. For item 4 (file picker library): survey 2–3 candidate
   libraries (or the headless-primitive option) and recommend
   one, with a concrete migration sketch.
4. For item 5 (writerly aesthetic): propose a small palette
   (3–4 colours) and a type pair (heading face + body face),
   with rationale. No CSS changes this iteration.

No implementation. Land the answer in `260_answer.md` and the
PLAN.md update.

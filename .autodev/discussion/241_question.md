# Two more user-visible issues on live v241

I exercised the live deploy and noted two more things that need
addressing. Pin each with a failing gold test before any fix
attempt (same protocol as iter 224 / iter 231 — smoke-test the
spec is RED on live before promoting it; otherwise the pin pins
nothing).

## 1. No way to delete a project

The `/projects` dashboard lists projects with editor links, but
there is no way for a user to delete a project. Add a delete
button next to each project row. Behaviour:

- Click → confirm dialog (avoid one-click destruction).
- On confirm, the project row + its sidecar Machine + its R2
  blobs are reaped, and the row disappears from the list.
- The user lands back on `/projects` with one fewer project.

This is also potentially relevant to the
**M9.live-hygiene.leaked-machines** focus iter 241 just named —
proper user-driven deletion is the right place to exercise the
same cleanup code path the live specs are supposed to invoke.
Consider co-designing them.

A gold test should land first: a freshly-seeded project,
clicked delete, confirmed, verified gone from the list and
verified at the DB / Fly Machine layer that the row + Machine
are reaped.

## 2. PDF preview only shows the first page

When the compiled document has multiple pages (e.g. anything
with a `\newpage` or sustained body content), only **page 1**
ever appears in the preview pane. The other pages are not
visible — no scrolling, no pagination affordance, just the
first page.

I am unsure whether the issue is in: (a) the PDF wire format /
how segments are streamed, (b) the preview canvas component
only rendering the first segment, or (c) something else. The
agent should diagnose and pin.

A gold test should drive a project whose body produces ≥ 3
pages (the existing GT-D / `\newpage` flows produce many
pages, so this is easy to set up) and assert ≥ 2 distinct
canvas elements (or one canvas of total height > one page) are
visible in the preview pane.

## Order of work

Same as before: pinning specs first (RED on live), then fixes.
Do not bundle a fix in the same iteration as its pin unless the
pin has been smoke-tested to fail on live first.

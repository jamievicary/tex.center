# New projects should seed `main.tex` with a hello-world template

When a user creates a new project today, the editor opens onto
an empty `main.tex` buffer — the first compile (if it fires at
all) produces a meaningless empty PDF, and the user has to know
LaTeX syntax to get anything useful.

Seed `main.tex` at project creation with the canonical 4-line
hello-world document:

```
\documentclass{article}
\begin{document}
Hello, world!
\end{document}
```

That's 4 lines exactly, syntactically valid, compiles cleanly
under lualatex.

Implementation is your call. Most natural place is probably at
project-creation time on the control plane (after `createProject`
inserts the `projects` row, write `main.tex` to the blob store
under `projects/<id>/files/main.tex`). An alternative is sidecar-
side at first-hydration time (if the blob store has no `main.tex`
when `getProject(id)` lazily loads, seed it then). Either works;
control-plane-side is slightly cleaner because it keeps the
sidecar's hydration logic pure-read.

Add a test that asserts the seeded content is exactly the
4-line template, so a future "let's just trim whitespace" or
"let's use a different starter" edit doesn't silently drift.

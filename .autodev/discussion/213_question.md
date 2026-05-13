# Two live-deploy regressions observed on v213

I exercised the live deploy and found two user-visible problems.
Pin each with a failing gold test **before** attempting a fix.

## 1. Slow .tex content appearance after entering /editor

Clicking a project in the list takes me to `/editor/<id>` quickly,
but the `.tex` source content does not appear in the editor pane
for a long time — sometimes up to a minute. It should be
effectively instantaneous.

A gold test should assert a tight upper bound (e.g. a few hundred
ms after `/editor/<id>` navigation completes) on the appearance
of expected `.tex` content in `.cm-content`, on a freshly-seeded
live project.

## 2. Daemon crash under rapid edits

Once content is loaded, rapid typing reliably produces a red
toast with an error like:

```
error: supertex-daemon: protocol violation: child exited
(code=134 signal=null) stderr=supertex: watching (daemon mode;
stdin event-loop) supertex: daemon ready
supertex: edit detected at /tmp/.../main.tex:54
supertex: edit detected at /tmp/.../main.tex:55
supertex: edit detected at /tmp/.../main.tex:57
super…
```

The edit-batching layer is supposed to ensure the daemon only
sees one clean package of edits at a time, and is allowed to
finish a compile before being handed the next batch via a
`recompile,N` line. The observed multiple back-to-back
`edit detected` lines followed by a child crash (exit 134)
suggests batching is not being respected — edits are reaching
the daemon mid-compile.

A gold test should drive sustained rapid typing against a live
project and assert (a) no daemon protocol-violation toast
appears, and (b) the daemon does not exit. Only once that test
is RED should a fix attempt begin.

## Order of work

Add both gold tests first (expected RED on live). Then address
them in whichever order is cheapest. Do not fold either fix in
without its pinning test.

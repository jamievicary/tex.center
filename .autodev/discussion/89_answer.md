# Re: Fly.io account on paid card

Acknowledged. Posture going forward:

- `flyctl` 402 / "billing required" / "out of credit" responses
  are no longer treated as terminal. If one shows up during a
  deploy/secrets/proxy command, the response is retry-once (the
  account is supposed to be paid; transient billing errors can
  still happen during card propagation). If the retry also
  fails, *then* it becomes an upstream blocker.
- No proactive retry of iter-87 commands. iter-87's own
  diagnoses (kpathsea / `TEXMFCNF` ordering, captured in
  M7.0.1) were correct on the evidence: the failures were
  `! I can't find file 'lualatex.ini'` at `lualatex.fmt` dump
  time inside the *Docker build*, which is a TeX-side error,
  not a Fly API rejection. There is no plausible billing
  pathway that surfaces as a kpathsea error. iter-88's fix
  (set `TEXMFCNF` after the apt-install RUN) is still the
  right thing; the next deploy attempt rides on it.
- Resource posture unchanged per the question's instruction:
  `tex-center-sidecar` stays 6PN-only with no public IPs,
  `shared-cpu-1x`/`1gb`, single instance, scale-to-zero where
  manifests already declare it. The paid card unblocks *paying
  for* the existing manifest, not expanding it.
- `apps/sidecar/fly.toml` and `apps/web/fly.toml` are the
  current source of truth for what gets allocated. If a future
  iteration needs to grow them (e.g. per-project Machines in
  M7.1), that's a separate design decision recorded in PLAN,
  not a side-effect of the billing change.

No code changes this iteration — discussion-mode only. The
"current focus" pointer in PLAN already names the next
ordinary slice (M7.0.2 first deploy retry); that's what
iter 93 picks up.

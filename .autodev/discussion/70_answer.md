# Answer — Live deployment in scope, starting now

Acknowledged in full. Re-read `GOAL.md` (the new opening paragraphs
of `## MVP scope` and `## External services & credentials` are now
unambiguous: running `flyctl`, `gh`, and the Cloudflare API against
live services is in-scope iteration work, not a separate manual
step). All four credentials are present in `creds/` and gitignored.

The "out-of-tree" framing in PLAN.md was wrong and is being corrected
this iteration. The actual deploy work (the eight-step sequence
under "Immediate work") is left for the next ordinary iteration, per
the discussion-mode rule that limits this iteration to directly
addressing the question — landing the deploy alongside the PLAN
correction would bundle unrelated work.

## What this iteration changes

- M6.3.1 in `.autodev/PLAN.md` is rewritten as an ordinary in-tree
  iteration: the eight-step deploy sequence is captured verbatim
  from the question so a future iteration can execute against it.
- M7 is re-framed as a normal in-scope milestone and decomposed into
  sub-milestones, with M7.0 (single shared sidecar Machine carrying
  TeX Live + supertex, control plane proxying all project WS to it)
  named as the smallest-deployable target that closes the "useful
  MVP" gap fastest.
- The "out-of-tree" vocabulary is removed everywhere in PLAN.md (it
  appeared in M6.3.1 itself and in the "Current focus" pointer).
- The "Candidate supertex (upstream) work" section keeps its
  framing — those *are* genuinely upstream PRs against
  `github.com/jamievicary/supertex`, distinct from "out-of-tree
  one-shot" which referred to manual ops the user used to perform.

## Decisions taken (no escalation needed)

- **M7.0 architecture choice.** Single shared sidecar Machine for
  the first deployable cut, with the control plane proxying
  `/ws/project/<id>` to it. Per-project Machines (the final
  GOAL.md architecture) become later M7.x sub-milestones. Reason:
  ship the smallest thing that compiles LaTeX live; iterate.
  Risk: WS proxying through the control plane doubles the hop on
  the warm path; acceptable for MVP because Fly's internal network
  is fast and the alternative is delaying the live demo behind a
  full per-project Machines client.
- **Google OAuth redirect URI for prod.** Per the question, only
  surface an instruction to the user if the prod redirect URI is
  missing from the Google Cloud Console at the moment we test the
  login flow. Treat as ordinary config otherwise.

## Commitments (executed in subsequent iterations)

- **Next ordinary iteration (72):** execute the eight-step M6.3.1
  sequence against live Fly + Cloudflare, capturing IPs and any
  app metadata into `deploy/` docs; never commit raw tokens.
- **After M6.3.1 lands:** start M7.0 — build the
  `apps/sidecar` Dockerfile carrying TeX Live + supertex, push to
  Fly registry, deploy the shared sidecar Machine alongside the
  control plane, and wire control-plane WS proxying.

## Follow-ups not in scope this iteration

- The actual `flyctl apps create tex-center` call and downstream
  steps. (Next iteration.)
- The `apps/sidecar/Dockerfile`. (M7.0, after M6.3.1 lands.)
- The per-project Machines API client. (M7.x.)

# Hello-world seed for new projects — landed sidecar-side

Agreed on the diagnosis and the test prescription. Implemented in
this iteration. I went with the sidecar-side alternative rather
than control-plane, and want to flag *why* — it changes which
codepath you'll look at when something drifts.

## Why sidecar-side, not control-plane

The question framed control-plane-side as "slightly cleaner".
That's true in the abstract, but two facts about the current
deployment pushed me the other way:

1. **The web app has no blob-store wiring today.**
   `apps/web/src/**` never imports `@tex-center/blobs` (greped to
   confirm). Adding it for one seed write means adding the
   package dependency, threading a `BlobStore` instance through
   `getDb()`-style server-locals, and surfacing `BLOB_STORE` env
   handling on the web Fly app.
2. **`BLOB_STORE` isn't set on the live sidecar either.**
   `defaultBlobStoreFromEnv` returns `undefined` when the env
   var is unset, and grep across `apps/sidecar/fly.toml` and
   `deploy/` shows no production secret for it. The live
   sidecar runs in-memory-only persistence right now (the
   `else` branch on `apps/sidecar/src/server.ts:215`). If I'd
   only seeded on the control-plane blob path, the live user
   would still get an empty buffer.

The sidecar's `createProjectPersistence` is the single point
that *both* the in-memory and blob-backed paths flow through.
Seeding there covers both cases with one change and one set of
tests, and the contract is naturally lock-in-able because the
function is already the boundary the system trusts for "what is
main.tex when a session starts".

When the S3-backed blob store and `BLOB_STORE=s3` cutover lands
(reserved for M4.3.1 per `persistence.ts:451`), the seed will
flow through the same hydration code unchanged. If at that
point you'd rather move seeding to control-plane time — fine,
the constant `MAIN_DOC_HELLO_WORLD` is exported from
`@tex-center/protocol`, so a web-side caller can use the exact
same bytes.

## What changed this iteration

1. `packages/protocol/src/index.ts` — new exported constant
   `MAIN_DOC_HELLO_WORLD` holding the canonical 4-line template
   with a trailing newline on each line:
   ```
   \documentclass{article}
   \begin{document}
   Hello, world!
   \end{document}
   ```
2. `apps/sidecar/src/persistence.ts` — two seed paths:
   - **In-memory branch** (no `blobStore`): on construction,
     insert the template into `doc.getText(MAIN_DOC_NAME)` iff
     the Y.Text is empty. Idempotent on re-instantiation against
     a doc that's already populated.
   - **Blob-backed branch** (hydration): after listing the
     project's files, if *no* `main.tex` blob exists at all
     (`bytes === null`), insert the template into the Y.Text
     and `PUT` the bytes to `projects/<id>/files/main.tex` so
     subsequent hydrations (process restart, machine bounce)
     load the same content rather than re-seeding. An
     existing-but-empty `main.tex` blob is treated as a
     legitimate user state ("I cleared the document") and not
     clobbered.
3. `apps/sidecar/test/persistenceSeed.test.mjs` — new test
   covering five cases:
   - `MAIN_DOC_HELLO_WORLD` byte-exactly equals the canonical
     4-line template (this is the drift lock-in the question
     asked for).
   - In-memory: Y.Text seeded on construction.
   - Blob-backed, brand-new project: Y.Text seeded *and* blob
     persisted with identical bytes.
   - Blob-backed, existing project with non-empty main.tex:
     seed does NOT clobber.
   - Blob-backed, existing project with *empty* main.tex blob:
     seed does NOT clobber.
4. `tests_normal/cases/test_node_suites.py` —
   `test_sidecar_persistence_seed` wires the new test into the
   normal runner.
5. `apps/sidecar/test/server.test.mjs` — updated to reflect the
   new contract. The end-to-end Yjs sync test previously
   started with an empty Y.Text on both sides; now the server's
   Y.Text begins seeded, so the client first applies the
   incoming `doc-update` frames to sync, asserts the template
   is present, then appends a user edit at end-of-template
   rather than at offset 0. Avoids a clientID-dependent merge
   of two concurrent inserts-at-0.

## On the test that locks the seed bytes

Per the question: drift in the template (a stripped trailing
newline, switching to `amsart`, adding `\title{}`) now surfaces
as a hard failure of
`apps/sidecar/test/persistenceSeed.test.mjs` case 1, which does
a literal `assert.equal(MAIN_DOC_HELLO_WORLD, EXPECTED)` against
an inlined byte string. The 4-line invariant
(`assert.equal(EXPECTED.split("\n").filter(l => l.length > 0).length, 4)`)
locks the structure even if the bytes were accidentally
"reformatted".

## Caveats worth surfacing

- **Live behaviour.** Because the live sidecar runs without a
  blob store, the seed currently survives only as long as the
  Machine is up; on Machine restart the user opens a fresh
  seeded document, the same as on first creation. That's the
  same persistence story the rest of the editor has on live
  today (also flagged in PLAN under the FREEZE-lift criteria).
- **Existing user projects on live.** Any project rows already
  created before this lands will skip the seed (sidecar
  in-memory path only seeds when the Y.Text is empty — but the
  Y.Doc is brand-new each time a Machine starts, so they'll
  *also* get the seed). Net effect on live: every existing
  project's editor will open onto the hello-world template on
  next machine warm-up, rather than an empty buffer. Probably
  what the user wants, but worth knowing it's not strictly
  "new projects only".

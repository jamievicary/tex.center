# Future ideas

- **Session sweeper scheduling.** Storage primitive
  `deleteExpiredSessions(db, now)` landed iter 54; wire it to a
  periodic caller (cron, on-boot pass, or admin route) when one
  exists.
- **`GET /auth/logout` link affordance.** Today only `POST` works;
  for an email-link or status-page link, a CSRF-protected GET→POST
  shim would be needed.
- **File-tree CRUD verbs.** Create (iter 61), delete (iter 62),
  rename (iter 63), and text upload (iter 66) landed.
- **Binary asset upload.** `upload-file` currently carries
  UTF-8 text only (it populates a `Y.Text`). Images / fonts / PDFs
  need a separate binary-blob channel and a way for the compile
  workspace to read them — design step deferred until the
  per-project Machine model (M7) is in place.
- **docker-compose bring-up for Postgres + MinIO.** M4.2.1 is
  covered by PGlite for DDL-level checks, but the file-blob side
  of M4.3 (Tigris object store, sidecar hydration round-trip)
  still wants a real local stack. Spin Postgres + MinIO behind a
  compose file with a CI host that has Docker; gold cases gate
  on `which docker`.

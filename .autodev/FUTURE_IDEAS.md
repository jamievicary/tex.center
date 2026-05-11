# Future ideas

- **Session sweeper scheduling.** Storage primitive
  `deleteExpiredSessions(db, now)` landed iter 54; wire it to a
  periodic caller (cron, on-boot pass, or admin route) when one
  exists.
- **`GET /auth/logout` link affordance.** Today only `POST` works;
  for an email-link or status-page link, a CSRF-protected GET→POST
  shim would be needed.
- **File-tree CRUD verbs.** Create landed iter 61 (`create-file`
  protocol verb + FileTree input row + `persistence.addFile`).
  Rename / delete still need protocol messages and a path that
  updates `knownFiles` / `persistedByName` and broadcasts the
  refreshed `file-list`. Delete must also remove the blob.
- **docker-compose bring-up for Postgres + MinIO.** M4.2.1 is
  covered by PGlite for DDL-level checks, but the file-blob side
  of M4.3 (Tigris object store, sidecar hydration round-trip)
  still wants a real local stack. Spin Postgres + MinIO behind a
  compose file with a CI host that has Docker; gold cases gate
  on `which docker`.

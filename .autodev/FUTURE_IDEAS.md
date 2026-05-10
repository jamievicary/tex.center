# Future ideas

- **Session sweeper.** `DELETE FROM sessions WHERE expires_at <
  now()`; ride on any periodic task once one exists.
- **JWKS clock-skew tolerance** in `verifyGoogleIdToken` (iter 36
  noted; still open after iter 39).
- **`GET /auth/logout` link affordance.** Today only `POST` works;
  for an email-link or status-page link, a CSRF-protected GET→POST
  shim would be needed.
- **docker-compose bring-up for Postgres + MinIO.** M4.2.1 is
  covered by PGlite for DDL-level checks, but the file-blob side
  of M4.3 (Tigris object store, sidecar hydration round-trip)
  still wants a real local stack. Spin Postgres + MinIO behind a
  compose file with a CI host that has Docker; gold cases gate
  on `which docker`.

// Integration test for `findOrCreateUserByGoogleSub` and
// `insertSession` against the in-process PGlite engine. Real
// migrations are applied first so the helpers run against the
// same DDL that prod will.

import assert from 'node:assert/strict';

import { drizzle } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';

import {
  deleteExpiredSessions,
  deleteSession,
  findOrCreateUserByGoogleSub,
  getSessionWithUser,
  insertSession,
  schema,
  sessions,
  users,
} from '../src/index.ts';

import { freshMigratedPglite } from './_pgliteHarness.mjs';

const { pg } = await freshMigratedPglite();
try {
  // PGlite's drizzle adapter has a different concrete class than
  // postgres-js's, but the query-builder surface is identical. The
  // cast keeps the prod helper strongly typed.
  const db = /** @type {any} */ (drizzle(pg, { schema }));

  // --- findOrCreateUserByGoogleSub: fresh insert -----------------
  const created = await findOrCreateUserByGoogleSub(db, {
    googleSub: 'google-sub-A',
    email: 'a@example.com',
    displayName: 'A',
  });
  assert.equal(created.googleSub, 'google-sub-A');
  assert.equal(created.email, 'a@example.com');
  assert.equal(created.displayName, 'A');
  assert.ok(created.id);
  assert.ok(created.createdAt instanceof Date);
  assert.ok(created.updatedAt instanceof Date);

  // --- second call with same sub: returns same row id, refreshes email/name
  // updated_at must move forward — sleep at least 1ms.
  await new Promise((r) => setTimeout(r, 5));
  const refreshed = await findOrCreateUserByGoogleSub(db, {
    googleSub: 'google-sub-A',
    email: 'a-new@example.com',
    displayName: 'A New',
  });
  assert.equal(refreshed.id, created.id, 'same google_sub → same row id');
  assert.equal(refreshed.email, 'a-new@example.com');
  assert.equal(refreshed.displayName, 'A New');
  assert.ok(
    refreshed.updatedAt.getTime() >= created.updatedAt.getTime(),
    'updated_at must not move backwards',
  );

  // --- different google_sub: new row -----------------------------
  const other = await findOrCreateUserByGoogleSub(db, {
    googleSub: 'google-sub-B',
    email: 'b@example.com',
  });
  assert.notEqual(other.id, created.id);
  assert.equal(other.displayName, null);

  // exactly two user rows total
  const allUsers = await db.select().from(users);
  assert.equal(allUsers.length, 2);

  // --- regression (iter 131): same email + different google_sub --
  // The iter-109 deploy-verification seed pre-inserts a placeholder
  // google_sub against the live email; the first real OAuth callback
  // arrives with the same email but a different google_sub. Before
  // 0002_drop_users_email_unique, that combination hit
  // `UNIQUE (email)` before the `ON CONFLICT (google_sub)` branch
  // and 500'd the callback. After the migration, the new google_sub
  // creates a fresh row alongside the placeholder.
  const sameEmail = await findOrCreateUserByGoogleSub(db, {
    googleSub: 'google-sub-C',
    email: 'a-new@example.com', // matches `refreshed.email` above
    displayName: 'C',
  });
  assert.notEqual(sameEmail.id, created.id, 'different google_sub → different row');
  assert.equal(sameEmail.email, 'a-new@example.com');
  const afterDupEmail = await db.select().from(users);
  assert.equal(afterDupEmail.length, 3);

  // --- insertSession ---------------------------------------------
  const exp = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  const session = await insertSession(db, {
    userId: created.id,
    expiresAt: exp,
  });
  assert.ok(session.id);
  assert.equal(session.userId, created.id);
  assert.equal(session.expiresAt.getTime(), exp.getTime());
  assert.ok(session.createdAt instanceof Date);

  // sanity: row is actually queryable by id
  const rows = await db.select().from(sessions).where(eq(sessions.id, session.id));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].userId, created.id);

  // FK enforcement: insertSession against a non-existent userId throws.
  let fkErr;
  try {
    await insertSession(db, {
      userId: '00000000-0000-0000-0000-000000000000',
      expiresAt: exp,
    });
  } catch (e) {
    fkErr = e;
  }
  assert.ok(fkErr, 'insertSession with bad userId must throw (FK)');

  // --- getSessionWithUser: happy path ----------------------------
  const lookup = await getSessionWithUser(db, session.id);
  assert.ok(lookup, 'session must be found by id');
  assert.equal(lookup.session.id, session.id);
  assert.equal(lookup.session.userId, created.id);
  assert.equal(lookup.user.id, created.id);
  assert.equal(lookup.user.email, refreshed.email);
  assert.equal(lookup.user.googleSub, 'google-sub-A');

  // --- getSessionWithUser: unknown sid → null --------------------
  const miss = await getSessionWithUser(
    db,
    '11111111-1111-1111-1111-111111111111',
  );
  assert.equal(miss, null);

  // --- deleteSession: unknown sid → false, no rows removed -------
  const noop = await deleteSession(
    db,
    '22222222-2222-2222-2222-222222222222',
  );
  assert.equal(noop, false);
  const stillThere = await getSessionWithUser(db, session.id);
  assert.ok(stillThere, 'unknown-sid delete must not affect other rows');

  // --- deleteSession: real sid → true, row gone, user kept -------
  const removed = await deleteSession(db, session.id);
  assert.equal(removed, true);
  const after = await getSessionWithUser(db, session.id);
  assert.equal(after, null);
  const userStill = await db.select().from(users).where(eq(users.id, created.id));
  assert.equal(userStill.length, 1, 'deleteSession must not cascade to users');

  // --- deleteSession: second call on the same sid → false --------
  const repeated = await deleteSession(db, session.id);
  assert.equal(repeated, false);

  // --- deleteExpiredSessions ------------------------------------
  // Three sessions with distinct expiries: in the past, equal to
  // the sweep cutoff, and in the future.
  const past = new Date(Date.now() - 60 * 60 * 1000);
  const cutoff = new Date(Date.now() - 30 * 60 * 1000);
  const future = new Date(Date.now() + 60 * 60 * 1000);
  const sPast = await insertSession(db, { userId: created.id, expiresAt: past });
  const sEdge = await insertSession(db, { userId: created.id, expiresAt: cutoff });
  const sFuture = await insertSession(db, { userId: created.id, expiresAt: future });

  // Sweep at `cutoff`: strictly-before semantics — `sPast` goes,
  // `sEdge` (equal to cutoff) stays, `sFuture` stays.
  const removedCount = await deleteExpiredSessions(db, cutoff);
  assert.equal(removedCount, 1, 'exactly one session was strictly before cutoff');
  assert.equal(await getSessionWithUser(db, sPast.id), null);
  assert.ok(await getSessionWithUser(db, sEdge.id));
  assert.ok(await getSessionWithUser(db, sFuture.id));

  // Sweep again at the same instant: no-op.
  assert.equal(await deleteExpiredSessions(db, cutoff), 0);

  // Sweep at a much later instant: both remaining rows go.
  const later = new Date(future.getTime() + 60 * 60 * 1000);
  assert.equal(await deleteExpiredSessions(db, later), 2);
  assert.equal(await getSessionWithUser(db, sEdge.id), null);
  assert.equal(await getSessionWithUser(db, sFuture.id), null);

  // Users untouched by session sweep.
  const usersAfter = await db.select().from(users);
  assert.equal(usersAfter.length, 3);

  console.log('users + sessions PGlite test: OK');
} finally {
  await pg.close();
}

// One-shot: seed/lookup live user row for jamievicary@gmail.com.
import { findOrCreateUserByGoogleSub, createDb, closeDb } from '@tex-center/db';
const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required'); process.exit(2); }
const h = createDb(url, { onnotice: () => {} });
try {
  const u = await findOrCreateUserByGoogleSub(h.db, {
    googleSub: process.env.GOOGLE_SUB ?? 'probe-jamievicary-livefix',
    email: 'jamievicary@gmail.com',
    displayName: 'Jamie Vicary',
  });
  console.log(u.id);
} finally {
  await closeDb(h);
}

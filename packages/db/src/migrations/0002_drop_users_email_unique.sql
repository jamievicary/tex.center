-- Drop the redundant UNIQUE constraint on users.email.
--
-- Identity in this schema is `google_sub` (the stable OAuth subject
-- identifier); the email allowlist gates which accounts can sign in
-- at all. The `UNIQUE (email)` constraint added nothing useful and
-- caused a production-down 500 (iter 131): the iter-109 deploy-
-- verification seed inserted a row with a placeholder
-- `google_sub = 'probe-jamievicary-livefix'` and the live
-- `email = 'jamievicary@gmail.com'`; the first real OAuth callback
-- tried `INSERT ... ON CONFLICT (google_sub) DO UPDATE`, the
-- google_sub was different, so the email-uniqueness constraint
-- fired first and the upsert blew up before reaching the conflict
-- branch.
--
-- After this migration, `findOrCreateUserByGoogleSub`'s
-- ON CONFLICT (google_sub) is the sole upsert key, which matches
-- the semantic intent.

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_email_key;

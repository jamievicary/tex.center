-- M15 Step D: optional per-project seed for `main.tex`.
--
-- When a row is created with `seed_doc` non-null, the sidecar
-- inserts those bytes into `Y.Text("main.tex")` on first
-- hydration instead of the canonical `MAIN_DOC_HELLO_WORLD`. Used
-- by tests that need to assert behaviour on multi-page (or other
-- non-default) source without going through an editing flow. The
-- value is consulted exactly once per project (first hydration
-- only); once persisted to the blob store, hydration prefers the
-- blob and `seed_doc` is ignored.

ALTER TABLE projects ADD COLUMN seed_doc text NULL;

# Future ideas

- **In-process Postgres for M4.2.1.** Evaluate PGlite
  (`@electric-sql/pglite`) as an alternative to docker-compose
  for the migration-apply integration test. Trade-off: hermetic
  + no host Docker required, but a different SQL surface than
  prod Postgres so DDL-level coverage only.

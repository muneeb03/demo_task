// Runs before any module is imported by a test file, so src/db.ts picks up the test database.
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://ledger:ledger@localhost:5433/ledger_test';

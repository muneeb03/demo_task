// The single Postgres pool for the whole process. Its size caps how many withdrawals
// can be in flight, so the tests depend on it being wider than their concurrency burst.
import { Pool } from 'pg';

export const DEFAULT_DATABASE_URL = 'postgres://ledger:ledger@localhost:5433/ledger';

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
  // Comfortably above the 10 simultaneous withdrawals the concurrency test fires, so
  // requests queue on the account row lock inside Postgres rather than in the client pool.
  max: Number(process.env.PG_POOL_MAX ?? 20),
});

pool.on('error', (err) => {
  console.error('[pg] unexpected idle client error', err);
});

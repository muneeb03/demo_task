import { pool } from '../src/db';

// Each test file gets its own module registry, and so its own pool to close.
afterAll(async () => {
  await pool.end();
});

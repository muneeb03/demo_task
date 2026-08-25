import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { pool as defaultPool } from './db';

// Resolves to <repo>/db/schema.sql from both src/ (ts-node) and dist/ (compiled).
export const SCHEMA_PATH = join(__dirname, '..', 'db', 'schema.sql');

/** Applies the (idempotent) schema. Called on server startup and before the test suite. */
export async function migrate(pool: Pool = defaultPool): Promise<void> {
  await pool.query(readFileSync(SCHEMA_PATH, 'utf8'));
}

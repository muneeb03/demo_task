// Runs once before the suite: wait for Postgres, create the database, apply the schema,
// truncate. Truncation is per run rather than per test, which is why every test creates
// its own account and why helpers.uniqueKey() exists.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://ledger:ledger@localhost:5433/ledger_test';

const DUPLICATE_DATABASE = '42P04';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const quoteIdentifier = (name: string): string => `"${name.replace(/"/g, '""')}"`;

/** Waits for the docker-compose Postgres to accept connections. */
async function connectWithRetry(connectionString: string, timeoutMs = 60_000): Promise<Client> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  while (Date.now() < deadline) {
    const client = new Client({ connectionString });
    try {
      await client.connect();
      return client;
    } catch (err) {
      lastError = err;
      await client.end().catch(() => undefined);
      await sleep(500);
    }
  }

  throw new Error(
    `Could not reach Postgres within ${timeoutMs}ms. Is it running? Try: npm run db:up\n${String(lastError)}`,
  );
}

export default async function globalSetup(): Promise<void> {
  const url = new URL(TEST_DATABASE_URL);
  const databaseName = decodeURIComponent(url.pathname.replace(/^\//, ''));

  // Connect to the default database first so the test database can be created if missing.
  const adminUrl = new URL(TEST_DATABASE_URL);
  adminUrl.pathname = '/postgres';

  const admin = await connectWithRetry(adminUrl.toString());
  try {
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
  } catch (err) {
    if ((err as { code?: string }).code !== DUPLICATE_DATABASE) {
      throw err;
    }
  } finally {
    await admin.end();
  }

  const db = new Client({ connectionString: TEST_DATABASE_URL });
  await db.connect();
  try {
    await db.query(readFileSync(join(__dirname, '..', 'db', 'schema.sql'), 'utf8'));
    // Every run starts from a clean ledger.
    await db.query('TRUNCATE transactions, accounts RESTART IDENTITY CASCADE');
  } finally {
    await db.end();
  }
}

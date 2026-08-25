import type { PoolClient } from 'pg';
import { pool } from './db';
import { accountNotFound, ApiError } from './errors';
import type { AccountRow, TransactionRow } from './models';
import type { CreateAccountInput, WithdrawalInput } from './validation';

const UNIQUE_VIOLATION = '23505';

const isUniqueViolation = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && (err as { code?: string }).code === UNIQUE_VIOLATION;

function first<T>(rows: T[]): T {
  const row = rows[0];
  if (!row) {
    throw new Error('Expected the statement to return exactly one row.');
  }
  return row;
}

export async function createAccount(input: CreateAccountInput): Promise<AccountRow> {
  const { rows } = await pool.query<AccountRow>(
    'INSERT INTO accounts (owner, balance) VALUES ($1, $2::numeric) RETURNING *',
    [input.owner, input.balance],
  );
  return first(rows);
}

export async function getAccount(id: string): Promise<AccountRow> {
  const { rows } = await pool.query<AccountRow>('SELECT * FROM accounts WHERE id = $1', [id]);
  const account = rows[0];
  if (!account) {
    throw accountNotFound(id);
  }
  return account;
}

export async function listTransactions(accountId: string): Promise<TransactionRow[]> {
  // 404 for an unknown account rather than an empty list, which would hide a client bug.
  await getAccount(accountId);
  const { rows } = await pool.query<TransactionRow>(
    'SELECT * FROM transactions WHERE account_id = $1 ORDER BY created_at DESC, id DESC',
    [accountId],
  );
  return rows;
}

export interface WithdrawalResult {
  transaction: TransactionRow;
  /** True when this key had already been used and the stored result was returned unchanged. */
  replayed: boolean;
}

const CLAIM_KEY = `
  INSERT INTO transactions (account_id, amount, address, network, idempotency_key, status)
  VALUES ($1, $2::numeric, $3, $4, $5, 'pending')
  RETURNING *`;

// The balance check lives in the WHERE clause, so it is evaluated by Postgres while it
// holds the row lock. Zero rows back means the funds were not there.
const DEBIT = `
  UPDATE accounts
     SET balance = balance - $2::numeric
   WHERE id = $1
     AND balance >= $2::numeric
  RETURNING balance`;

const SETTLE = 'UPDATE transactions SET status = $2 WHERE id = $1 RETURNING *';

/**
 * Withdraw to an external address.
 *
 * Everything below happens inside one database transaction so the debit and the ledger
 * row commit or disappear together. Concurrency safety comes from the conditional UPDATE
 * (a lost update is impossible because Postgres re-checks `balance >= amount` after
 * waiting for any concurrent writer), and idempotency from the UNIQUE constraint on
 * (transactions.account_id, transactions.idempotency_key).
 */
export async function withdraw(accountId: string, input: WithdrawalInput): Promise<WithdrawalResult> {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Reject unknown accounts before the idempotency key is consumed.
    const account = await client.query('SELECT 1 FROM accounts WHERE id = $1', [accountId]);
    if (account.rowCount === 0) {
      throw accountNotFound(accountId);
    }

    // 1. Claim the idempotency key for this account. A simultaneous request carrying the
    //    same key blocks on the unique index here and fails with 23505 the moment we commit,
    //    so at most one attempt per (account, key) is ever recorded.
    let transaction: TransactionRow;
    try {
      const claimed = await client.query<TransactionRow>(CLAIM_KEY, [
        accountId,
        input.amount,
        input.address,
        input.network,
        input.idempotencyKey,
      ]);
      transaction = first(claimed.rows);
    } catch (err) {
      if (!isUniqueViolation(err)) {
        throw err;
      }
      await client.query('ROLLBACK');
      // The transaction is finished, so the connection we already hold serves the read.
      // Taking a second one from the pool here would tie correctness to PG_POOL_MAX.
      return { transaction: await replayStoredResult(client, accountId, input), replayed: true };
    }

    // 2. Debit atomically: no read-then-write gap for a concurrent request to slip into.
    const debit = await client.query(DEBIT, [accountId, input.amount]);
    const funded = debit.rowCount === 1;

    // 3. Settle the attempt in the same transaction. A rejected withdrawal is still part
    //    of the account's history, recorded as `failed` with no money moved.
    const settled = await client.query<TransactionRow>(SETTLE, [
      transaction.id,
      funded ? 'completed' : 'failed',
    ]);
    transaction = first(settled.rows);

    await client.query('COMMIT');
    return { transaction, replayed: false };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Returns the result already stored under this account's idempotency key. */
async function replayStoredResult(
  client: PoolClient,
  accountId: string,
  input: WithdrawalInput,
): Promise<TransactionRow> {
  const { rows } = await client.query<TransactionRow & { params_match: boolean }>(
    `SELECT *,
            (amount = $3::numeric AND address = $4 AND network = $5) AS params_match
       FROM transactions
      WHERE account_id = $2 AND idempotency_key = $1`,
    [input.idempotencyKey, accountId, input.amount, input.address, input.network],
  );

  const existing = rows[0];
  if (!existing) {
    // Only reachable if the winning transaction rolled back between our conflict and this
    // read, which leaves the key free again — the caller can simply retry.
    throw new ApiError(
      409,
      'IDEMPOTENCY_CONFLICT',
      'A concurrent request is using this idempotency key. Retry the request.',
    );
  }

  if (!existing.params_match) {
    // Replaying a different request under the same key would return a result that does not
    // describe what was asked for, so it is refused instead.
    throw new ApiError(
      409,
      'IDEMPOTENCY_KEY_REUSED',
      'This idempotency key was already used with different withdrawal parameters.',
    );
  }

  return existing;
}

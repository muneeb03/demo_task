import type { Network } from './validation';

export type TransactionStatus = 'pending' | 'completed' | 'failed';

/** Rows exactly as Postgres returns them. `numeric` arrives as a string — never a float. */
export interface AccountRow {
  id: string;
  owner: string;
  balance: string;
  created_at: Date;
}

export interface TransactionRow {
  id: string;
  account_id: string;
  amount: string;
  address: string;
  network: Network;
  idempotency_key: string;
  status: TransactionStatus;
  created_at: Date;
}

export interface AccountResponse {
  id: string;
  owner: string;
  balance: string;
  createdAt: string;
}

export interface TransactionResponse {
  id: string;
  accountId: string;
  amount: string;
  address: string;
  network: Network;
  idempotencyKey: string;
  status: TransactionStatus;
  createdAt: string;
}

// Monetary values stay strings on the way out: JSON numbers are IEEE-754 doubles and
// would silently round large or high-precision amounts.
export const toAccount = (row: AccountRow): AccountResponse => ({
  id: row.id,
  owner: row.owner,
  balance: row.balance,
  createdAt: row.created_at.toISOString(),
});

export const toTransaction = (row: TransactionRow): TransactionResponse => ({
  id: row.id,
  accountId: row.account_id,
  amount: row.amount,
  address: row.address,
  network: row.network,
  idempotencyKey: row.idempotency_key,
  status: row.status,
  createdAt: row.created_at.toISOString(),
});

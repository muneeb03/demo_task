import request from 'supertest';
import type { Test } from 'supertest';
import { app } from '../src/app';

export const api = () => request(app);

/** Format-valid sample addresses (checksums are out of scope by design). */
export const VALID_TRC20 = 'TJRabPrwbZy45sbavfcjinPJC18kjpRTv8';
export const VALID_ERC20 = '0x742d35Cc6634C0532925a3b844Bc454e4438f44e';

export interface AccountBody {
  id: string;
  owner: string;
  balance: string;
  createdAt: string;
}

export interface TransactionBody {
  id: string;
  accountId: string;
  amount: string;
  address: string;
  network: string;
  idempotencyKey: string;
  status: string;
  createdAt: string;
}

let counter = 0;
export const uniqueKey = (label: string): string => `${label}-${process.pid}-${++counter}`;

export async function createAccount(owner: string, balance: number): Promise<AccountBody> {
  const res = await api().post('/accounts').send({ owner, balance }).expect(201);
  return res.body as AccountBody;
}

export function withdraw(
  accountId: string,
  body: Record<string, unknown>,
): Test {
  return api().post(`/accounts/${accountId}/withdraw`).send(body);
}

export async function getBalance(accountId: string): Promise<number> {
  const res = await api().get(`/accounts/${accountId}`).expect(200);
  return Number((res.body as AccountBody).balance);
}

export async function getTransactions(accountId: string): Promise<TransactionBody[]> {
  const res = await api().get(`/accounts/${accountId}/transactions`).expect(200);
  return (res.body as { transactions: TransactionBody[] }).transactions;
}

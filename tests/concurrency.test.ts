// The core claim: simultaneous withdrawals can never overdraw an account.
import {
  createAccount,
  getBalance,
  getTransactions,
  uniqueKey,
  VALID_ERC20,
  VALID_TRC20,
  withdraw,
  type TransactionBody,
} from './helpers';

describe('concurrent withdrawals', () => {
  it('lets exactly 3 of 10 simultaneous withdrawals succeed when the balance covers 3', async () => {
    const account = await createAccount('concurrency-exact', 300);

    // All ten are in flight before any of them commits.
    const responses = await Promise.all(
      Array.from({ length: 10 }, () =>
        withdraw(account.id, {
          amount: 100,
          address: VALID_TRC20,
          network: 'TRC20',
          idempotencyKey: uniqueKey('concurrent'),
        }),
      ),
    );

    const succeeded = responses.filter((res) => res.status === 201);
    const rejected = responses.filter((res) => res.status === 409);

    expect(succeeded).toHaveLength(3);
    expect(rejected).toHaveLength(7);
    // Nothing errored out in some other way.
    expect(succeeded.length + rejected.length).toBe(responses.length);

    for (const res of rejected) {
      expect(res.body.error.code).toBe('INSUFFICIENT_FUNDS');
      expect(res.body.error.transaction.status).toBe('failed');
    }

    const balance = await getBalance(account.id);
    expect(balance).toBe(0);
    expect(balance).toBeGreaterThanOrEqual(0);

    // The ledger agrees with the balance: three debits of 100, nothing lost.
    const history = await getTransactions(account.id);
    const completed = history.filter((tx: TransactionBody) => tx.status === 'completed');
    const failed = history.filter((tx: TransactionBody) => tx.status === 'failed');

    expect(history).toHaveLength(10);
    expect(completed).toHaveLength(3);
    expect(failed).toHaveLength(7);

    // Money is conserved: starting balance minus what was debited is what remains.
    const debited = completed.reduce((sum, tx) => sum + Number(tx.amount), 0);
    expect(Number(account.balance) - debited).toBe(balance);
  });

  it('never overdraws when the amounts do not divide the balance evenly', async () => {
    // 250 covers three withdrawals of 75 (225) with 25 left over.
    const account = await createAccount('concurrency-remainder', 250);

    const responses = await Promise.all(
      Array.from({ length: 10 }, () =>
        withdraw(account.id, {
          amount: 75,
          address: VALID_TRC20,
          network: 'TRC20',
          idempotencyKey: uniqueKey('remainder'),
        }),
      ),
    );

    expect(responses.filter((res) => res.status === 201)).toHaveLength(3);
    expect(responses.filter((res) => res.status === 409)).toHaveLength(7);
    expect(await getBalance(account.id)).toBe(25);
  });

  it('keeps concurrent withdrawals on separate accounts independent', async () => {
    const [first, second] = await Promise.all([
      createAccount('isolated-a', 100),
      createAccount('isolated-b', 100),
    ]);

    const responses = await Promise.all(
      [first, second].flatMap((account) =>
        Array.from({ length: 4 }, () =>
          withdraw(account.id, {
            amount: 100,
            address: VALID_ERC20,
            network: 'ERC20',
            idempotencyKey: uniqueKey('isolated'),
          }),
        ),
      ),
    );

    // One success per account, not one across both.
    expect(responses.filter((res) => res.status === 201)).toHaveLength(2);
    expect(await getBalance(first.id)).toBe(0);
    expect(await getBalance(second.id)).toBe(0);
  });
});

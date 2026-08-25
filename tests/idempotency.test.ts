import {
  createAccount,
  getBalance,
  getTransactions,
  uniqueKey,
  VALID_TRC20,
  withdraw,
} from './helpers';

const request = (idempotencyKey: string, amount = 100) => ({
  amount,
  address: VALID_TRC20,
  network: 'TRC20',
  idempotencyKey,
});

describe('idempotency', () => {
  it('deducts once and returns the same result when a key is replayed', async () => {
    const account = await createAccount('idempotent-sequential', 300);
    const body = request(uniqueKey('replay'));

    const first = await withdraw(account.id, body).expect(201);
    const second = await withdraw(account.id, body).expect(201);

    expect(second.body).toEqual(first.body);
    expect(first.headers['idempotent-replay']).toBeUndefined();
    expect(second.headers['idempotent-replay']).toBe('true');

    expect(await getBalance(account.id)).toBe(200);
    expect(await getTransactions(account.id)).toHaveLength(1);
  });

  it('records a single withdrawal when the same key arrives concurrently', async () => {
    const account = await createAccount('idempotent-concurrent', 300);
    const body = request(uniqueKey('race'));

    // The unique constraint is what makes this safe: exactly one insert wins, the rest
    // are served the stored result.
    const responses = await Promise.all(
      Array.from({ length: 5 }, () => withdraw(account.id, body)),
    );

    const winner = responses[0]?.body;
    expect(winner).toBeDefined();
    for (const res of responses) {
      expect(res.status).toBe(201);
      expect(res.body).toEqual(winner);
    }

    expect(await getBalance(account.id)).toBe(200);
    expect(await getTransactions(account.id)).toHaveLength(1);
  });

  it('replays a rejected withdrawal instead of retrying it', async () => {
    const account = await createAccount('idempotent-failure', 50);
    const body = request(uniqueKey('rejected'), 100);

    const first = await withdraw(account.id, body).expect(409);
    const second = await withdraw(account.id, body).expect(409);

    expect(second.body).toEqual(first.body);
    expect(second.headers['idempotent-replay']).toBe('true');
    expect(await getBalance(account.id)).toBe(50);
  });

  it('refuses a key that is reused with different parameters', async () => {
    const account = await createAccount('idempotent-mismatch', 300);
    const key = uniqueKey('mismatch');

    await withdraw(account.id, request(key, 100)).expect(201);
    const reused = await withdraw(account.id, request(key, 200)).expect(409);

    expect(reused.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await getBalance(account.id)).toBe(200);
  });

  it('scopes the key to the account, so two accounts may use the same one', async () => {
    const [mine, theirs] = await Promise.all([
      createAccount('key-scope-mine', 300),
      createAccount('key-scope-theirs', 300),
    ]);
    const key = uniqueKey('shared-across-accounts');

    // The same key against a different account is a different withdrawal, not a replay:
    // a globally unique key would reject the second account for no good reason.
    const first = await withdraw(mine.id, request(key)).expect(201);
    const second = await withdraw(theirs.id, request(key)).expect(201);

    expect(second.body.id).not.toBe(first.body.id);
    expect(second.headers['idempotent-replay']).toBeUndefined();

    // Each account still replays its own key.
    const replay = await withdraw(mine.id, request(key)).expect(201);
    expect(replay.body).toEqual(first.body);
    expect(replay.headers['idempotent-replay']).toBe('true');

    expect(await getBalance(mine.id)).toBe(200);
    expect(await getBalance(theirs.id)).toBe(200);
  });

  it('does not consume the key when the request is invalid', async () => {
    const account = await createAccount('idempotent-invalid', 300);
    const key = uniqueKey('invalid-first');

    await withdraw(account.id, { ...request(key), address: 'not-an-address' }).expect(400);
    // The same key is still usable once the client fixes the request.
    await withdraw(account.id, request(key)).expect(201);

    expect(await getBalance(account.id)).toBe(200);
  });
});

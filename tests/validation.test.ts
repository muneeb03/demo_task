import {
  api,
  createAccount,
  getBalance,
  getTransactions,
  uniqueKey,
  VALID_ERC20,
  VALID_TRC20,
  withdraw,
  type TransactionBody,
} from './helpers';

const UNKNOWN_ACCOUNT_ID = '00000000-0000-4000-8000-000000000000';

const valid = (overrides: Record<string, unknown> = {}) => ({
  amount: 10,
  address: VALID_TRC20,
  network: 'TRC20',
  idempotencyKey: uniqueKey('validation'),
  ...overrides,
});

type Case = [string, Record<string, unknown>];

const fieldsIn = (body: { error: { details?: Array<{ field: string }> } }): string[] =>
  (body.error.details ?? []).map((detail) => detail.field);

describe('address validation', () => {
  const badAddresses: Case[] = [
    ['an ERC20 address on the TRC20 network', { address: VALID_ERC20, network: 'TRC20' }],
    ['a TRC20 address on the ERC20 network', { address: VALID_TRC20, network: 'ERC20' }],
    ['a TRC20 address that is too short', { address: VALID_TRC20.slice(0, -1), network: 'TRC20' }],
    ['a TRC20 address with a non-base58 character', { address: `T0${VALID_TRC20.slice(2)}`, network: 'TRC20' }],
    ['an ERC20 address without the 0x prefix', { address: VALID_ERC20.slice(2), network: 'ERC20' }],
    ['an ERC20 address with a non-hex character', { address: `0xZ${VALID_ERC20.slice(3)}`, network: 'ERC20' }],
  ];

  it.each(badAddresses)('rejects %s', async (_label, overrides) => {
    const account = await createAccount('address-validation', 100);
    const res = await withdraw(account.id, valid(overrides)).expect(400);

    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(fieldsIn(res.body)).toContain('address');
    // Nothing was recorded and nothing moved.
    expect(await getTransactions(account.id)).toHaveLength(0);
    expect(await getBalance(account.id)).toBe(100);
  });

  const goodAddresses: Array<[string, string]> = [
    ['TRC20', VALID_TRC20],
    ['ERC20', VALID_ERC20],
  ];

  it.each(goodAddresses)('accepts a well formed %s address', async (network, address) => {
    const account = await createAccount('address-accepted', 100);
    const res = await withdraw(account.id, valid({ network, address })).expect(201);

    expect(res.body).toMatchObject({ network, address, status: 'completed', amount: '10' });
  });

  it('rejects an unknown network', async () => {
    const account = await createAccount('unknown-network', 100);
    const res = await withdraw(account.id, valid({ network: 'BEP20' })).expect(400);

    expect(fieldsIn(res.body)).toContain('network');
  });
});

describe('withdrawal body validation', () => {
  const badAmounts: Case[] = [
    ['a zero amount', { amount: 0 }],
    ['a negative amount', { amount: -10 }],
    ['a non-numeric amount', { amount: '10' }],
    ['a non-finite amount', { amount: Number.NaN }],
  ];

  it.each(badAmounts)('rejects %s', async (_label, overrides) => {
    const account = await createAccount('amount-validation', 100);
    const res = await withdraw(account.id, valid(overrides)).expect(400);

    expect(fieldsIn(res.body)).toContain('amount');
  });

  it('reports every missing field at once', async () => {
    const account = await createAccount('missing-fields', 100);
    const res = await withdraw(account.id, {}).expect(400);

    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(fieldsIn(res.body).sort()).toEqual(['address', 'amount', 'idempotencyKey', 'network']);
  });

  it('rejects a missing idempotency key', async () => {
    const account = await createAccount('missing-key', 100);
    const res = await withdraw(account.id, valid({ idempotencyKey: '  ' })).expect(400);

    expect(fieldsIn(res.body)).toContain('idempotencyKey');
  });

  it('rejects malformed JSON', async () => {
    const account = await createAccount('bad-json', 100);
    const res = await api()
      .post(`/accounts/${account.id}/withdraw`)
      .set('Content-Type', 'application/json')
      .send('{"amount":')
      .expect(400);

    expect(res.body.error.code).toBe('INVALID_JSON');
  });
});

describe('insufficient funds', () => {
  it('rejects a withdrawal larger than the balance and records the attempt', async () => {
    const account = await createAccount('overdraw', 50);
    const res = await withdraw(account.id, valid({ amount: 50.01 })).expect(409);

    expect(res.body.error.code).toBe('INSUFFICIENT_FUNDS');
    expect(res.body.error.transaction.status).toBe('failed');
    expect(await getBalance(account.id)).toBe(50);

    const history = await getTransactions(account.id);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ status: 'failed', amount: '50.01' });
  });

  it('allows a withdrawal of the entire balance', async () => {
    const account = await createAccount('exact-balance', 50);
    await withdraw(account.id, valid({ amount: 50 })).expect(201);

    expect(await getBalance(account.id)).toBe(0);
  });
});

describe('account lookups', () => {
  it('returns 404 for an unknown account', async () => {
    const res = await api().get(`/accounts/${UNKNOWN_ACCOUNT_ID}`).expect(404);
    expect(res.body.error.code).toBe('ACCOUNT_NOT_FOUND');
  });

  it('returns 404 when withdrawing from an unknown account', async () => {
    const res = await withdraw(UNKNOWN_ACCOUNT_ID, valid()).expect(404);
    expect(res.body.error.code).toBe('ACCOUNT_NOT_FOUND');
  });

  it('returns 404 when listing transactions for an unknown account', async () => {
    await api().get(`/accounts/${UNKNOWN_ACCOUNT_ID}/transactions`).expect(404);
  });

  it('returns 400 for an account id that is not a UUID', async () => {
    const res = await api().get('/accounts/not-a-uuid').expect(400);
    expect(res.body.error.code).toBe('INVALID_ACCOUNT_ID');
  });
});

describe('account creation validation', () => {
  const badAccounts: Case[] = [
    ['a missing owner', {}],
    ['an empty owner', { owner: '   ' }],
    ['a non-string owner', { owner: 42 }],
    ['a negative balance', { owner: 'someone', balance: -1 }],
    ['a non-numeric balance', { owner: 'someone', balance: '100' }],
  ];

  it.each(badAccounts)('rejects %s', async (_label, body) => {
    const res = await api().post('/accounts').send(body).expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 404 for an unknown route', async () => {
    await api().get('/nope').expect(404);
  });
});

describe('transaction history', () => {
  it('lists the account withdrawals newest first', async () => {
    const account = await createAccount('history', 100);

    await withdraw(account.id, valid({ amount: 10 })).expect(201);
    await withdraw(account.id, valid({ amount: 20 })).expect(201);
    await withdraw(account.id, valid({ amount: 500 })).expect(409);

    const history = await getTransactions(account.id);
    expect(history.map((tx: TransactionBody) => tx.amount)).toEqual(['500', '20', '10']);
    expect(history.every((tx: TransactionBody) => tx.accountId === account.id)).toBe(true);
  });

  it('does not leak transactions between accounts', async () => {
    const [mine, theirs] = await Promise.all([
      createAccount('history-mine', 100),
      createAccount('history-theirs', 100),
    ]);

    await withdraw(mine.id, valid({ amount: 10 })).expect(201);

    expect(await getTransactions(mine.id)).toHaveLength(1);
    expect(await getTransactions(theirs.id)).toHaveLength(0);
  });
});

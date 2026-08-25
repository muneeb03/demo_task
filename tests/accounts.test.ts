import { api, createAccount, getBalance, uniqueKey, VALID_ERC20, withdraw } from './helpers';

describe('accounts', () => {
  it('creates an account and returns it', async () => {
    const res = await api().post('/accounts').send({ owner: 'Ada Lovelace', balance: 1250.75 }).expect(201);

    expect(res.body).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      owner: 'Ada Lovelace',
      balance: '1250.75',
      createdAt: expect.any(String),
    });
  });

  it('defaults the balance to zero', async () => {
    const res = await api().post('/accounts').send({ owner: 'Grace Hopper' }).expect(201);
    expect(res.body.balance).toBe('0');
  });

  it('keeps money precise instead of rounding it like a float', async () => {
    // 0.1 + 0.2 !== 0.3 in IEEE-754; numeric columns and string responses keep it exact.
    const account = await createAccount('precision', 0.3);
    await withdraw(account.id, {
      amount: 0.1,
      address: VALID_ERC20,
      network: 'ERC20',
      idempotencyKey: uniqueKey('precision'),
    }).expect(201);

    const res = await api().get(`/accounts/${account.id}`).expect(200);
    expect(res.body.balance).toBe('0.2');
  });

  it('reads back the account it created', async () => {
    const account = await createAccount('round-trip', 42);
    const res = await api().get(`/accounts/${account.id}`).expect(200);

    expect(res.body).toEqual(account);
    expect(await getBalance(account.id)).toBe(42);
  });

  it('answers the health check', async () => {
    await api().get('/health').expect(200, { status: 'ok' });
  });
});

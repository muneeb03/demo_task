// What the sign-in layer must guarantee: a session cannot be forged, an account claimed by
// a Google identity cannot be touched by anyone else, and a token is not trusted until it
// has been proven. The Google round trip itself is not exercised here -- these tests stay
// offline -- but everything on our side of it is.
import { pool } from '../src/db';
import { mintSession, SESSION_COOKIE } from '../src/session';
import { api, createAccount, uniqueKey, VALID_TRC20 } from './helpers';

interface Owned {
  userId: string;
  accountId: string;
  cookie: string;
}

/** An account claimed by a Google identity, plus a valid session cookie for its owner. */
async function signedInUser(label: string): Promise<Owned> {
  const key = uniqueKey(label);

  const users = await pool.query<{ id: string }>(
    'INSERT INTO users (google_sub, email, name) VALUES ($1, $2, $3) RETURNING id',
    [`google-sub-${key}`, `${key}@example.com`, label],
  );
  const userId = users.rows[0]?.id;

  const accounts = await pool.query<{ id: string }>(
    'INSERT INTO accounts (owner, balance, user_id) VALUES ($1, $2::numeric, $3) RETURNING id',
    [label, '500', userId],
  );
  const accountId = accounts.rows[0]?.id;

  if (!userId || !accountId) {
    throw new Error('Could not set up a signed-in user.');
  }

  return { userId, accountId, cookie: `${SESSION_COOKIE}=${mintSession(userId, accountId)}` };
}

const withdrawal = (amount = 10) => ({
  amount,
  address: VALID_TRC20,
  network: 'TRC20',
  idempotencyKey: uniqueKey('auth'),
});

describe('sign-in configuration', () => {
  afterEach(() => {
    delete process.env.GOOGLE_CLIENT_ID;
  });

  it('tells the page that Google sign-in is not configured', async () => {
    const res = await api().get('/auth/config').expect(200);

    expect(res.body).toMatchObject({ clientId: null, configured: false });
    // The nonce is issued either way, so the page never has to special-case it.
    expect(res.body.nonce).toEqual(expect.stringMatching(/^\d+\.[\w-]+$/));
  });

  it('hands the page the client id once it is configured', async () => {
    process.env.GOOGLE_CLIENT_ID = 'test-client-id.apps.googleusercontent.com';
    const res = await api().get('/auth/config').expect(200);

    expect(res.body).toMatchObject({
      clientId: 'test-client-id.apps.googleusercontent.com',
      configured: true,
    });
  });

  it('refuses to accept a credential when no client id is set', async () => {
    // Without an expected audience there is nothing to check a token against, so accepting
    // one would mean accepting a token issued for any application at all.
    const res = await api().post('/auth/google').send({ credential: 'x.y.z' }).expect(503);
    expect(res.body.error.code).toBe('GOOGLE_AUTH_UNCONFIGURED');
  });
});

describe('credential verification', () => {
  beforeEach(() => {
    process.env.GOOGLE_CLIENT_ID = 'test-client-id.apps.googleusercontent.com';
  });

  afterEach(() => {
    delete process.env.GOOGLE_CLIENT_ID;
  });

  const rejected: Array<[string, unknown]> = [
    ['a missing credential', undefined],
    ['a credential that is not a string', 42],
    ['a credential that is not a JWT', 'not-a-jwt'],
  ];

  it.each(rejected)('rejects %s', async (_label, credential) => {
    await api().post('/auth/google').send({ credential }).expect((res) => {
      expect([400, 401]).toContain(res.status);
    });
  });

  // The alg-confusion classic: a token that asks to be verified with no signature at all,
  // or with a symmetric key the attacker also controls.
  it.each(['none', 'HS256'])('refuses a token asking to be verified with alg=%s', async (alg) => {
    const header = Buffer.from(JSON.stringify({ alg, kid: 'anything' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ sub: '1', email: 'a@b.c' })).toString('base64url');

    const res = await api()
      .post('/auth/google')
      .send({ credential: `${header}.${payload}.` })
      .expect(401);

    expect(res.body.error.code).toBe('INVALID_CREDENTIAL');
    // Rejected on the header alone: no key was fetched and no claim was read.
    expect(res.body.error.message).toMatch(/RS256|well-formed/);
  });
});

describe('the session-scoped surface', () => {
  const signedOut: Array<[string, 'get' | 'post', string]> = [
    ['GET /me', 'get', '/me'],
    ['GET /me/account', 'get', '/me/account'],
    ['GET /me/transactions', 'get', '/me/transactions'],
    ['POST /me/withdraw', 'post', '/me/withdraw'],
  ];

  it.each(signedOut)('answers 401 to %s without a session', async (_label, method, path) => {
    const res = await api()[method](path).expect(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('returns the signed-in user and their account', async () => {
    const owner = await signedInUser('me-endpoint');
    const res = await api().get('/me').set('Cookie', owner.cookie).expect(200);

    expect(res.body.account).toMatchObject({ id: owner.accountId, balance: '500' });
    expect(res.body.user).toEqual({
      id: owner.userId,
      email: expect.stringContaining('@example.com'),
      name: 'me-endpoint',
      picture: null,
    });
    // google_sub is not the browser's business, and neither is the account's owner column.
    expect(res.body.user).not.toHaveProperty('google_sub');
    expect(res.body.account).not.toHaveProperty('user_id');
  });

  it('withdraws from the account the session names, with no id in the request', async () => {
    const owner = await signedInUser('me-withdraw');

    const res = await api()
      .post('/me/withdraw')
      .set('Cookie', owner.cookie)
      .send(withdrawal(120))
      .expect(201);

    expect(res.body).toMatchObject({ accountId: owner.accountId, amount: '120', status: 'completed' });

    const after = await api().get('/me/account').set('Cookie', owner.cookie).expect(200);
    expect(after.body.balance).toBe('380');

    const history = await api().get('/me/transactions').set('Cookie', owner.cookie).expect(200);
    expect(history.body.transactions).toHaveLength(1);
  });

  it('replays an idempotency key through /me the same way as through /accounts', async () => {
    const owner = await signedInUser('me-idempotent');
    const body = withdrawal(50);

    const first = await api().post('/me/withdraw').set('Cookie', owner.cookie).send(body).expect(201);
    const second = await api().post('/me/withdraw').set('Cookie', owner.cookie).send(body).expect(201);

    expect(second.body).toEqual(first.body);
    expect(second.headers['idempotent-replay']).toBe('true');

    const after = await api().get('/me/account').set('Cookie', owner.cookie).expect(200);
    expect(after.body.balance).toBe('450');
  });

  it('clears the session on sign-out', async () => {
    const owner = await signedInUser('sign-out');
    const res = await api().post('/auth/logout').set('Cookie', owner.cookie).expect(204);

    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toContain(`${SESSION_COOKIE}=;`);
    expect(cookie).toContain('Max-Age=0');
    expect(cookie).toContain('HttpOnly');
  });
});

describe('session integrity', () => {
  const tamper = (cookie: string, mutate: (token: string) => string): string => {
    const token = cookie.slice(`${SESSION_COOKIE}=`.length);
    return `${SESSION_COOKIE}=${mutate(token)}`;
  };

  it('refuses a cookie whose payload was edited', async () => {
    const victim = await signedInUser('tamper-victim');
    const attacker = await signedInUser('tamper-attacker');

    // Swap in the victim's ids but keep the attacker's signature: the HMAC no longer matches.
    const forged = tamper(attacker.cookie, (token) => {
      const payload = Buffer.from(
        JSON.stringify({
          userId: victim.userId,
          accountId: victim.accountId,
          expiresAt: Math.floor(Date.now() / 1000) + 3600,
        }),
      ).toString('base64url');
      return `${payload}.${token.slice(token.indexOf('.') + 1)}`;
    });

    await api().get('/me').set('Cookie', forged).expect(401);
  });

  it('refuses a cookie with no signature at all', async () => {
    const owner = await signedInUser('unsigned');
    const unsigned = tamper(owner.cookie, (token) => `${token.slice(0, token.indexOf('.'))}.`);

    await api().get('/me').set('Cookie', unsigned).expect(401);
  });

  // A URIError escaping the cookie reader used to surface as a 500, which both
  // leaks that something threw and lets an unauthenticated caller pick the
  // status code by sending a broken escape.
  it.each(['%', 'abc%zz', '%E0%A4%A'])('answers 401, not 500, to the malformed cookie %s', async (value) => {
    for (const path of ['/me', '/me/account', '/me/transactions']) {
      const res = await api().get(path).set('Cookie', `${SESSION_COOKIE}=${value}`);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHENTICATED');
    }
  });

  it('refuses a session that has expired', async () => {
    const owner = await signedInUser('expired');
    // Signed by us, so only the expiry can reject it.
    const expired = `${SESSION_COOKIE}=${mintSession(owner.userId, owner.accountId)}`;
    const realNow = Date.now;
    Date.now = () => realNow() + 8 * 24 * 60 * 60 * 1000;
    try {
      await api().get('/me').set('Cookie', expired).expect(401);
    } finally {
      Date.now = realNow;
    }
  });
});

describe('account ownership', () => {
  it('leaves anonymous accounts open, exactly as the ledger API always was', async () => {
    const account = await createAccount('still-anonymous', 100);

    await api().get(`/accounts/${account.id}`).expect(200);
    await api().post(`/accounts/${account.id}/withdraw`).send(withdrawal(10)).expect(201);
    await api().get(`/accounts/${account.id}/transactions`).expect(200);
  });

  const guarded: Array<[string, 'get' | 'post', (id: string) => string]> = [
    ['reading it', 'get', (id) => `/accounts/${id}`],
    ['withdrawing from it', 'post', (id) => `/accounts/${id}/withdraw`],
    ['listing its transactions', 'get', (id) => `/accounts/${id}/transactions`],
  ];

  it.each(guarded)('refuses %s with no session', async (_label, method, path) => {
    const owner = await signedInUser('guarded');
    const res = await api()[method](path(owner.accountId)).send(withdrawal()).expect(401);

    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it.each(guarded)('refuses %s with somebody else\'s session', async (_label, method, path) => {
    const owner = await signedInUser('guarded-owner');
    const stranger = await signedInUser('guarded-stranger');

    const res = await api()[method](path(owner.accountId))
      .set('Cookie', stranger.cookie)
      .send(withdrawal())
      .expect(403);

    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('lets the owner through on their own account', async () => {
    const owner = await signedInUser('guarded-allowed');

    const res = await api().get(`/accounts/${owner.accountId}`).set('Cookie', owner.cookie).expect(200);
    expect(res.body.id).toBe(owner.accountId);
  });

  it('does not let a rejected caller move money or learn anything', async () => {
    const owner = await signedInUser('guard-side-effects');
    const stranger = await signedInUser('guard-side-effects-stranger');

    await api()
      .post(`/accounts/${owner.accountId}/withdraw`)
      .set('Cookie', stranger.cookie)
      .send(withdrawal(500))
      .expect(403);

    const after = await api().get('/me/account').set('Cookie', owner.cookie).expect(200);
    expect(after.body.balance).toBe('500');
    const history = await api().get('/me/transactions').set('Cookie', owner.cookie).expect(200);
    expect(history.body.transactions).toHaveLength(0);
  });

  it('still answers 400 for an id that is not a UUID, before any lookup', async () => {
    const res = await api().get('/accounts/not-a-uuid').expect(400);
    expect(res.body.error.code).toBe('INVALID_ACCOUNT_ID');
  });

  it('still answers 404 for an account that does not exist', async () => {
    const res = await api().get('/accounts/00000000-0000-4000-8000-000000000000').expect(404);
    expect(res.body.error.code).toBe('ACCOUNT_NOT_FOUND');
  });
});

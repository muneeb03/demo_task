// Turning a verified Google profile into a ledger identity. Sign-in is an upsert rather
// than a create-or-fail, so the second visit refreshes the display name and avatar without
// a separate code path.
import { pool } from './db';
import type { AccountRow, UserRow } from './models';

// A fresh account with nothing in it cannot demonstrate a withdrawal, so first sign-in
// opens the account with a simulated balance. This ledger is a simulation throughout.
const SIGNUP_BALANCE = (() => {
  const configured = process.env.SIGNUP_BALANCE?.trim();
  // Guarded because the value is interpolated into a numeric column: a bad env var should
  // fall back, not become a runtime error on every sign-in.
  return configured && /^\d+(\.\d+)?$/.test(configured) ? configured : '1000';
})();

const UNIQUE_VIOLATION = '23505';

const UPSERT_USER = `
  INSERT INTO users (google_sub, email, name, picture)
       VALUES ($1, $2, $3, $4)
  ON CONFLICT (google_sub)
    DO UPDATE SET email = EXCLUDED.email, name = EXCLUDED.name, picture = EXCLUDED.picture
    RETURNING *`;

export interface Identity {
  user: UserRow;
  account: AccountRow;
}

/** Finds or creates the user behind a verified Google profile, and the account they own. */
export async function signIn(profile: {
  sub: string;
  email: string;
  name: string;
  picture: string | null;
}): Promise<Identity> {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const users = await client.query<UserRow>(UPSERT_USER, [
      profile.sub,
      profile.email,
      profile.name,
      profile.picture,
    ]);
    const user = users.rows[0];
    if (!user) {
      throw new Error('Expected the user upsert to return a row.');
    }

    const existing = await client.query<AccountRow>('SELECT * FROM accounts WHERE user_id = $1', [
      user.id,
    ]);
    const account = existing.rows[0] ?? (await openAccount(client, user));

    await client.query('COMMIT');
    return { user, account };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Opens the one account a user gets. Racing sign-ins are resolved by the unique index. */
async function openAccount(
  client: { query: typeof pool.query },
  user: UserRow,
): Promise<AccountRow> {
  try {
    const created = await client.query<AccountRow>(
      'INSERT INTO accounts (owner, balance, user_id) VALUES ($1, $2::numeric, $3) RETURNING *',
      [user.name || user.email, SIGNUP_BALANCE, user.id],
    );
    const account = created.rows[0];
    if (!account) {
      throw new Error('Expected the account insert to return a row.');
    }
    return account;
  } catch (err) {
    // Two tabs signing in at once: accounts_user_id_key lets exactly one insert through,
    // and the loser reads the winner's account instead of creating a second one.
    if ((err as { code?: string }).code !== UNIQUE_VIOLATION) {
      throw err;
    }
    const { rows } = await client.query<AccountRow>('SELECT * FROM accounts WHERE user_id = $1', [
      user.id,
    ]);
    const account = rows[0];
    if (!account) {
      throw new Error('Account insert conflicted but no account exists.');
    }
    return account;
  }
}

/** The user id that owns an account, `null` if it is anonymous, `undefined` if there is no such account. */
export async function accountOwner(accountId: string): Promise<string | null | undefined> {
  const { rows } = await pool.query<{ user_id: string | null }>(
    'SELECT user_id FROM accounts WHERE id = $1',
    [accountId],
  );
  return rows[0]?.user_id;
}

/** Re-reads the identity a session points at. Returns undefined if it no longer exists. */
export async function findIdentity(userId: string): Promise<Identity | undefined> {
  // Two plain selects rather than one join through to_jsonb: jsonb renders `numeric` as a
  // JSON number, which would hand the balance back as a rounded float -- the one thing this
  // ledger exists to avoid. Read as columns, `numeric` arrives as a string.
  const users = await pool.query<UserRow>('SELECT * FROM users WHERE id = $1', [userId]);
  const user = users.rows[0];
  if (!user) {
    return undefined;
  }

  const accounts = await pool.query<AccountRow>('SELECT * FROM accounts WHERE user_id = $1', [
    user.id,
  ]);
  const account = accounts.rows[0];

  return account ? { user, account } : undefined;
}

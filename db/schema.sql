-- Applied on server startup (src/migrate.ts) and before the test suite runs.
-- Written to be idempotent so it can safely run on every boot.

CREATE TABLE IF NOT EXISTS accounts (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner      text        NOT NULL,
  -- numeric (arbitrary precision), never float: money must not round.
  -- The CHECK is the last line of defence for the "no negative balance" rule.
  balance    numeric     NOT NULL DEFAULT 0 CHECK (balance >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS transactions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid        NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  amount          numeric     NOT NULL CHECK (amount > 0),
  address         text        NOT NULL,
  network         text        NOT NULL CHECK (network IN ('TRC20', 'ERC20')),
  idempotency_key text        NOT NULL,
  status          text        NOT NULL CHECK (status IN ('pending', 'completed', 'failed')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  -- Scoped to the account rather than global: two accounts may legitimately pick the same
  -- key, and one must not reject the other. Within an account the UNIQUE constraint is what
  -- makes idempotency safe under concurrency -- two simultaneous requests carrying the same
  -- key cannot both insert a row.
  UNIQUE (account_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS transactions_account_created_idx
  ON transactions (account_id, created_at DESC, id DESC);

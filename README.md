# Crypto Ledger API

A simulated crypto ledger REST API: accounts hold a balance, and withdrawals to an external
TRC20/ERC20 address debit that balance. No blockchain is involved — the ledger is the database.

Node.js · Express · TypeScript · PostgreSQL · Jest + Supertest

## Running it

Everything runs in Docker, the API included:

```bash
docker compose up --build       # or: npm run docker:up
curl localhost:3000/health
```

That is all it takes to have the API serving on `http://localhost:3000` — no local Node needed.
The image is multi-stage (compiled with devDependencies, shipped with production dependencies
only), runs as the non-root `node` user, and exposes a healthcheck on `/health` so `--wait`
returns when the API is genuinely serving. The `api` container waits for Postgres to pass its own
healthcheck, then applies [`db/schema.sql`](db/schema.sql) on startup, so a virgin database
migrates itself.

### Tests

```bash
npm install
npm test                        # brings up Postgres, then runs the whole suite
```

Requires Node 18+. `npm test` is the single command: it runs `docker compose up -d --wait db`
first, so Postgres is healthy before Jest starts. The tests deliberately do **not** go through the
`api` container — Supertest drives the Express app in-process, so the database is the only thing
they need, and routing them through the image would add a rebuild to every run. They use a
dedicated `ledger_test` database that is created, migrated and truncated automatically, so
development data is never touched.

### Working on the code

```bash
npm run db:up                   # Postgres only, on host port 5433
npm run dev                     # ts-node against it (or: npm run build && npm start)
npm run docker:down             # stop everything and delete the volume
```

Stop the `api` container first if it is holding port 3000.

| Variable            | Default                                                                                           |
| ------------------- | ------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`      | `postgres://ledger:ledger@localhost:5433/ledger` (the `api` service overrides this to `db:5432`)   |
| `TEST_DATABASE_URL` | the same, but database `ledger_test`                                                              |
| `PORT`              | `3000`                                                                                            |

## How the graded parts work

**Concurrency.** The whole withdrawal runs in one database transaction, and the debit is a single
atomic conditional update — `UPDATE accounts SET balance = balance - $amount WHERE id = $id AND
balance >= $amount RETURNING balance` ([`src/service.ts`](src/service.ts)). There is no
read-then-write gap for a racing request to slip into: when two transactions target the same row,
the second blocks on the row lock and Postgres re-evaluates `balance >= $amount` against the
*committed* value once the lock is released, so a lost update is impossible. Zero rows returned
means the funds were not there, which is reported as `409 INSUFFICIENT_FUNDS`. I chose this over
`SELECT … FOR UPDATE` because it locks for a shorter window and expresses the balance check as a
constraint rather than as an application-level decision; `CHECK (balance >= 0)` on the column backs
it up so the database itself would reject a negative balance even if the query were wrong.

**Idempotency.** `transactions` carries a `UNIQUE (account_id, idempotency_key)` constraint, and the
first thing a withdrawal does inside its transaction is insert a `pending` row claiming that key. A
second request with the same key cannot insert — if it arrives concurrently it blocks on the unique
index until the first commits and then fails with `23505`, which is caught and answered with the
stored transaction instead, byte-for-byte identical to the original response (plus an
`Idempotent-Replay: true` header). The debit and the ledger row commit together, so a key is never
charged twice and never charged zero times.

Two decisions in there are worth stating outright rather than leaving a reader to infer them. The key
is scoped to the account instead of being globally unique: two accounts may independently pick
`"retry-1"`, and one must not reject the other's withdrawal. And a rejected withdrawal is **terminal**
for its key — the attempt is recorded as `failed` and every replay returns that same `409`, so a
client that tops up and wants to try again must send a fresh key. That is the strict reading of
"return the same result as the first call": one key, one outcome, permanently. Requests that fail
validation never reach the database at all, so those keys stay free for a corrected retry.

**Address validation.** Format-only checks, no checksum libraries: TRC20 is `/^T[1-9A-HJ-NP-Za-km-z]{33}$/`
(34 base58 characters) and ERC20 is `/^0x[a-fA-F0-9]{40}$/`. The address is validated against the
network given in the same request, so an ERC20 address sent with `"network": "TRC20"` is rejected.

## API

Money is always a **string** in JSON. JSON numbers are IEEE-754 doubles, and `numeric` columns exist
precisely so balances do not round; serialising them as numbers would undo that. Amounts are accepted
as numbers per the spec and passed to Postgres as exact decimal strings.

### `POST /accounts` → `201`

```jsonc
// request                                  // response
{ "owner": "Ada", "balance": 300 }          { "id": "…", "owner": "Ada", "balance": "300", "createdAt": "…" }
```

`owner` is required; `balance` is optional and defaults to `0`.

### `GET /accounts/:id` → `200`

```json
{ "id": "…", "owner": "Ada", "balance": "200", "createdAt": "2026-01-01T00:00:00.000Z" }
```

### `POST /accounts/:id/withdraw` → `201`

```json
{ "amount": 100, "address": "TJRabPrwbZy45sbavfcjinPJC18kjpRTv8", "network": "TRC20", "idempotencyKey": "abc-123" }
```

```json
{
  "id": "…", "accountId": "…", "amount": "100",
  "address": "TJRabPrwbZy45sbavfcjinPJC18kjpRTv8", "network": "TRC20",
  "idempotencyKey": "abc-123", "status": "completed", "createdAt": "…"
}
```

A replay of a key that has already been used returns the stored result with `Idempotent-Replay: true`.

### `GET /accounts/:id/transactions` → `200`

```json
{ "transactions": [ { "id": "…", "status": "completed", "…": "…" } ] }
```

Newest first, including `failed` attempts, so the history explains the balance.

### Status codes

| Code  | When                                                                              |
| ----- | --------------------------------------------------------------------------------- |
| `201` | Account created, withdrawal accepted (and replays of an accepted withdrawal)       |
| `200` | Reads                                                                              |
| `400` | Malformed body or JSON, bad amount, missing field, address/network mismatch, non-UUID id |
| `404` | Unknown account, unknown route                                                     |
| `409` | `INSUFFICIENT_FUNDS`, or `IDEMPOTENCY_KEY_REUSED` when an account replays one of its keys with different parameters |

Errors share one envelope; validation errors list every offending field at once:

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "Request body failed validation.",
  "details": [ { "field": "address", "message": "address is not a valid ERC20 address." } ] } }
```

## Schema

```
accounts       id uuid pk · owner text · balance numeric CHECK (balance >= 0) · created_at timestamptz
transactions   id uuid pk · account_id uuid fk · amount numeric CHECK (amount > 0) · address text
               network text · idempotency_key text · status text · created_at timestamptz
               UNIQUE (account_id, idempotency_key)
```

`status` is `pending` → `completed` | `failed`. `pending` is only ever visible inside the transaction
that created it, since claiming the key and settling it happen in the same commit.

[`db/schema.sql`](db/schema.sql) uses `CREATE TABLE IF NOT EXISTS` so it is safe to re-run on every
boot — which also means it never alters a table that already exists. Changing the schema against a
database you have already created needs `npm run docker:down` (that drops the volume) plus a
`DROP DATABASE ledger_test`, or an explicit `ALTER`. A real deployment would want a migration tool
here; for a single-shot ledger it did not seem worth the dependency, but it is a limitation rather
than a design win.

## Tests

44 tests across four suites (`npm test`):

- **[`tests/concurrency.test.ts`](tests/concurrency.test.ts)** — 10 simultaneous withdrawals of 100
  against a balance of 300: exactly 3 succeed, 7 return `409`, the final balance is `0`, the ledger
  sums to the balance, and it never goes negative. Repeated with amounts that leave a remainder
  (10 × 75 against 250 → 3 succeed, 25 left) and with two accounts in flight at once.
- **[`tests/idempotency.test.ts`](tests/idempotency.test.ts)** — a replayed key deducts once and
  returns an identical body; five simultaneous requests carrying the same key produce exactly one
  transaction; a rejected withdrawal replays as the same `409`; a key reused with different
  parameters is refused; the same key on two different accounts is two withdrawals, not a replay;
  an invalid request does not burn the key.
- **[`tests/validation.test.ts`](tests/validation.test.ts)** — address/network mismatches in both
  directions, malformed addresses, unknown networks, zero, negative, non-numeric and non-finite
  amounts, missing fields, malformed JSON, overdrafts, unknown accounts and non-UUID ids.
- **[`tests/accounts.test.ts`](tests/accounts.test.ts)** — creation, read-back, defaults, and that
  `0.3 - 0.1` is exactly `0.2` rather than `0.19999999999999998`.

The concurrency suite was checked against a deliberately naive read-then-write implementation to
confirm it fails there: all 10 withdrawals were accepted and the balance lost updates, which is the
bug these tests exist to catch.

## Scope

Simulated ledger only — no blockchain interaction, no authentication (the caller is trusted), no UI.
Out of scope but worth naming in review: deposits, pagination on transaction history, and rate
limiting. In production I would also take amounts as strings or minor units rather than JSON numbers,
and expire idempotency keys after a retention window.

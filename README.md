# Crypto Ledger API

A simulated crypto ledger: accounts hold a balance, and withdrawals to an external TRC20/ERC20
address debit it. Node.js · Express · TypeScript · PostgreSQL.

## Run it

```bash
docker compose up --build          # API on localhost:3000, Postgres on 5433
curl localhost:3000/health
```

No local Node needed. The `api` container waits for Postgres to pass its healthcheck, then applies
[`db/schema.sql`](db/schema.sql) on startup, so a fresh database migrates itself.

## Test it

```bash
npm install
npm test                           # one command: starts Postgres, then runs 44 tests
```

Requires Node 18+ and Docker. Tests use a dedicated `ledger_test` database, created and truncated
automatically.

## Concurrency and idempotency

The whole withdrawal runs in one database transaction in which the debit is a single atomic
conditional update — `UPDATE accounts SET balance = balance - $amount WHERE id = $id AND balance >=
$amount` ([`src/service.ts`](src/service.ts)) — so there is no read-then-write gap for a racing
request to slip into: a second transaction blocks on the row lock, Postgres re-checks the balance
against the committed value, and zero rows updated means insufficient funds (`409`), with
`CHECK (balance >= 0)` as a backstop. Idempotency comes from a `UNIQUE (account_id, idempotency_key)`
constraint and a `pending` row inserted to claim the key as the transaction's first statement, so a
duplicate cannot insert — it blocks on the unique index, fails with `23505`, and is answered with the
stored transaction instead, byte-for-byte identical to the original. Because the debit and the ledger
row commit together, a key is never charged twice and never charged zero times.

## API

Money is a string in JSON, since JSON numbers are IEEE-754 doubles and `numeric` columns exist so
balances do not round. Addresses are format-checked against the network in the same request:
TRC20 `/^T[1-9A-HJ-NP-Za-km-z]{33}$/`, ERC20 `/^0x[a-fA-F0-9]{40}$/`.

| Endpoint | OK | |
| --- | --- | --- |
| `POST /accounts` | `201` | `{ owner, balance? }` → the account; `balance` defaults to `0` |
| `GET /accounts/:id` | `200` | → the account |
| `POST /accounts/:id/withdraw` | `201` | `{ amount, address, network, idempotencyKey }` → the transaction; a replay adds `Idempotent-Replay: true` |
| `GET /accounts/:id/transactions` | `200` | → `{ transactions }`, newest first, including `failed` attempts |

`400` malformed body/JSON, bad amount, missing field, address/network mismatch, non-UUID id ·
`404` unknown account or route · `409` `INSUFFICIENT_FUNDS`, or `IDEMPOTENCY_KEY_REUSED` when a key
is replayed with different parameters.

## Notes

Simulated ledger only — no blockchain, no auth, no UI. `npm run db:up` + `npm run dev` runs the API
locally against Postgres alone; `npm run docker:down` drops the volume. In production I would add a
migration tool, take amounts as strings or minor units, expire idempotency keys, and paginate history.

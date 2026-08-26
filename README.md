# Crypto Ledger

A simulated crypto ledger: accounts hold a balance, and withdrawals to an external TRC20/ERC20
address debit it. A web UI signs in with Google and shows you your own account; the REST API
underneath is the same one it has always been. Node.js · Express · TypeScript · PostgreSQL ·
no frontend framework and no build step.

## Run it

```bash
docker compose up --build          # UI and API on localhost:3000, Postgres on 5433
open http://localhost:3000
```

No local Node needed. The `api` container waits for Postgres to pass its healthcheck, then applies
[`db/schema.sql`](db/schema.sql) on startup, so a fresh database migrates itself.

The UI comes up whether or not Google sign-in is configured — without a client id the sign-in screen
says so instead of failing. To actually sign in, see below.

## Test it

```bash
npm install
npm test                           # one command: starts Postgres, then runs 74 tests
```

Requires Node 18+ and Docker. Tests use a dedicated `ledger_test` database, created and truncated
automatically. The 44 tests that predate the UI run unchanged.

## Sign in with Google

Set one environment variable. Five steps in the [Google Cloud Console](https://console.cloud.google.com):

1. **APIs & Services → OAuth consent screen.** User type *External*; fill in app name and the two
   contact emails. The only scopes needed are `openid`, `email` and `profile` — all non-sensitive,
   so no verification review. While the app is in *Testing*, only accounts listed under **Test users**
   can sign in; that is the usual reason sign-in works for you and for nobody else.
2. **Credentials → Create credentials → OAuth client ID → Web application.**
3. **Authorized JavaScript origins → `http://localhost:3000`.** Scheme, host and port only — no
   trailing slash, no path. `http://localhost:3000` and `http://127.0.0.1:3000` are *different*
   origins to Google; register whichever one you will actually type, or both.
4. **Authorized redirect URIs: leave empty.** This flow posts the token with `fetch`; it never redirects.
5. Copy the client id. The client *secret* is not used by this flow and must never reach the browser.

```bash
GOOGLE_CLIENT_ID=xxxx.apps.googleusercontent.com docker compose up --build
```

| Variable | Default | |
| --- | --- | --- |
| `GOOGLE_CLIENT_ID` | unset | Enables sign-in. Unset is a supported state, not an error. |
| `SESSION_SECRET` | random per boot | Signs the session cookie. Unset means sessions end when the process does. |
| `SESSION_COOKIE_SECURE` | `false` | Set to `true` behind HTTPS. Off by default because a `Secure` cookie is dropped on `http://localhost`. |
| `SIGNUP_BALANCE` | `1000` | Simulated funds a new account opens with, so a fresh sign-in has something to withdraw. |

### How the token is checked

The ID token is verified in [`src/googleAuth.ts`](src/googleAuth.ts) with nothing but `node:crypto`
and `fetch` — no dependency was added for it. Google's signing keys are fetched from the JWKS
endpoint and cached for as long as its `Cache-Control` says (hours, not seconds), selected by `kid`
so a rotation mid-cache is handled, and shared through a single in-flight promise so a cold cache
under load makes one request rather than one per sign-in.

Order matters and is deliberate: `alg` is pinned to RS256 **before** a key is looked up, the
signature is checked **before** any claim is read, and only then are `iss`, `aud`, `azp`, `exp`,
`iat`, `nbf` and `email_verified` checked. Pinning `alg` first is what defeats the `alg: none` and
HMAC-confusion forgeries; checking `aud` is what stops a perfectly valid Google token minted for
some *other* application from being accepted as one of ours.

There is also a nonce. `GET /auth/config` issues one — an HMAC over its own timestamp, so it costs
no server state — the page hands it to Google, and Google echoes it back inside the ID token where
it is checked. Without it, a token captured elsewhere could be replayed against this server.

After that the Google token has done its job and is discarded. What the browser keeps is our own
session: `base64url(payload).HMAC-SHA256`, `HttpOnly`, `SameSite=Lax`, with the signature compared
in constant time. It is a signed cookie rather than a row in a table because the payload is small,
fixed and self-expiring, so a database round trip per request would buy nothing. `SameSite=Lax`
means a cross-site POST — the shape a CSRF attempt takes — arrives without it.

## Who can touch which account

Sign-in creates a `users` row keyed on Google's `sub` claim (not the email: an email can be
reassigned, `sub` never is) and opens exactly one account for it, enforced by a unique index on
`accounts (user_id)`.

The browser talks to a **session-scoped surface** that takes no account id at all — `GET /me`,
`GET /me/account`, `GET /me/transactions`, `POST /me/withdraw`. Identity comes from the cookie, so
the UI never holds, and can never be talked into sending, somebody else's account id. Those routes
delegate to the same service functions as the REST API; only the source of the account id differs.

The original `/accounts/:id` routes are guarded by ownership rather than by a blanket login wall.
`accounts.user_id` is nullable, and the two cases are treated differently on purpose:

- **Claimed** (`user_id` set — every account created by signing in): reachable only with that user's
  session. No session is `401`; the wrong session is `403`. Nothing is validated, read or debited
  before that check.
- **Anonymous** (`user_id` NULL — everything the public `POST /accounts` creates): unguarded, exactly
  as documented below. This is what keeps the ledger API, and its 44 tests, unchanged.

So a signed-in user's balance cannot be moved by anyone else, while the demo API stays open against
the anonymous accounts it was always open against. In production the anonymous half would sit behind
a service credential; the split is drawn here to keep one honest boundary rather than a login wall
with an escape hatch in it.

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

The UI mints an idempotency key with `crypto.randomUUID()` when the form is first submitted and
reuses it for every retry of that same attempt, so a resend after a dropped connection replays
rather than charging twice. A replay is not paraphrased away: the page quotes the
`Idempotent-Replay: true` header verbatim and marks the row that already existed.

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
| `GET /auth/config` | `200` | → `{ clientId, configured, nonce }` for the sign-in page |
| `POST /auth/google` | `200` | `{ credential }` → `{ user, account }`, and sets the session cookie |
| `POST /auth/logout` | `204` | clears the session cookie |
| `GET /me` · `GET /me/account` · `GET /me/transactions` | `200` | the signed-in user's own |
| `POST /me/withdraw` | `201` | as `/accounts/:id/withdraw`, but the account comes from the session |

`400` malformed body/JSON, bad amount, missing field, address/network mismatch, non-UUID id ·
`401` no session, or a credential that failed verification · `403` an account owned by someone else ·
`404` unknown account or route · `409` `INSUFFICIENT_FUNDS`, or `IDEMPOTENCY_KEY_REUSED` when a key
is replayed with different parameters · `503` sign-in attempted with no `GOOGLE_CLIENT_ID` set.

## The web UI

[`public/`](public/) — three files, no framework, no bundler, no dependencies, served by
`express.static`. Two screens: sign in, and one page showing your balance, a withdrawal form and
your transaction history.

The design is a settlement statement rather than a dashboard. Structure is carried by 1px hairlines
and space — there is no card, no shadow and no fill larger than a 6px square anywhere in the
stylesheet. Light and dark are both first-class and cross hue deliberately, so neither reads as a
filter of the other: warm paper in light, cool graphite in dark.

Its one real idea is the **decimal axis**. Every amount is split into an integer half and a fraction
half of fixed character widths, so `9.20`, `1,250.75` and `10,000.00` all hang their decimal point on
one hairline running down the ledger — the same reason accountants rule their columns, and a visible
argument that this software knows exactly where the decimal point is. Two details follow from it:
digits the server never sent (the `0` that turns `0.2` into `0.20`) are ghosted rather than printed
in the same ink, because `"0.2"` and `"0.20"` are different facts; and a declined withdrawal is a
struck-through figure, which says "recorded, but not charged" without a word of copy.

Money from the server is never passed through `Number()` — it is formatted by string surgery. The
one place a number is correct is the amount you type, because the API takes `amount` as a JSON
number, and even there the form refuses to send a value that would not survive the round trip
through a double intact.

## Notes

Simulated ledger only — no blockchain, and balances are granted rather than deposited.
`npm run db:up` + `npm run dev` runs everything locally against Postgres alone; `npm run docker:down`
drops the volume. In production I would add a migration tool, take amounts as strings or minor units,
expire idempotency keys, paginate history, and put the anonymous half of the account API behind a
service credential.

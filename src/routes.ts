// The HTTP surface. Each handler validates, calls the service, and maps the result --
// no business logic and no SQL, so the rules stay in one place.
import { Router, type Request, type RequestHandler, type Response } from 'express';
import { ApiError } from './errors';
import { toAccount, toTransaction } from './models';
import { readCookie, readSession, SESSION_COOKIE } from './session';
import { createAccount, getAccount, listTransactions, withdraw, type WithdrawalResult } from './service';
import { accountOwner } from './users';
import { parseAccountId, parseCreateAccount, parseWithdrawal } from './validation';

/** Express 4 does not forward rejected promises to the error middleware; this does. */
const asyncHandler =
  (handler: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next) => {
    handler(req, res).catch(next);
  };

/**
 * A completed withdrawal and a rejected one are both real outcomes of the same request, and
 * both replay identically, so they are rendered in one place and shared with /me/withdraw.
 */
export function sendWithdrawal(res: Response, { transaction, replayed }: WithdrawalResult): void {
  // Lets a client tell a replay from the original without changing the payload.
  if (replayed) {
    res.setHeader('Idempotent-Replay', 'true');
  }

  if (transaction.status === 'completed') {
    res.status(201).json(toTransaction(transaction));
    return;
  }

  // A recorded-but-rejected withdrawal. The message is deliberately free of any
  // live balance so that a replay of this key is byte-for-byte identical.
  res.status(409).json({
    error: {
      code: 'INSUFFICIENT_FUNDS',
      message: 'Account balance is too low for this withdrawal.',
      transaction: toTransaction(transaction),
    },
  });
}

export const router = Router();

router.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

/**
 * Ownership, enforced before any handler below touches the account.
 *
 * An account claimed by a Google identity is reachable only with that identity's session.
 * An account with no owner -- everything the public POST /accounts creates -- stays open,
 * so the ledger API documented in the README behaves exactly as it always has. The web UI
 * never uses these routes at all; it talks to the session-scoped /me surface instead.
 */
const guardOwnedAccount: RequestHandler = (req, res, next) => {
  void (async (): Promise<void> => {
    const owner = await accountOwner(parseAccountId(req.params.id));

    // undefined: no such account -- left to the handler, which owns the 404 and its wording.
    // null: anonymous, and deliberately unguarded.
    if (owner == null) {
      next();
      return;
    }

    const session = readSession(readCookie(req.headers.cookie, SESSION_COOKIE));
    if (!session) {
      throw new ApiError(401, 'UNAUTHENTICATED', 'This account belongs to a signed-in user.');
    }
    if (session.userId !== owner) {
      throw new ApiError(403, 'FORBIDDEN', 'This account belongs to someone else.');
    }

    next();
  })().catch(next);
};

router.use('/accounts/:id', guardOwnedAccount);

router.post(
  '/accounts',
  asyncHandler(async (req, res) => {
    const account = await createAccount(parseCreateAccount(req.body));
    res.status(201).json(toAccount(account));
  }),
);

router.get(
  '/accounts/:id',
  asyncHandler(async (req, res) => {
    const account = await getAccount(parseAccountId(req.params.id));
    res.status(200).json(toAccount(account));
  }),
);

router.post(
  '/accounts/:id/withdraw',
  asyncHandler(async (req, res) => {
    const accountId = parseAccountId(req.params.id);
    sendWithdrawal(res, await withdraw(accountId, parseWithdrawal(req.body)));
  }),
);

router.get(
  '/accounts/:id/transactions',
  asyncHandler(async (req, res) => {
    const transactions = await listTransactions(parseAccountId(req.params.id));
    res.status(200).json({ transactions: transactions.map(toTransaction) });
  }),
);

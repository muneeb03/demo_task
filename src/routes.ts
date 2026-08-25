import { Router, type Request, type RequestHandler, type Response } from 'express';
import { toAccount, toTransaction } from './models';
import { createAccount, getAccount, listTransactions, withdraw } from './service';
import { parseAccountId, parseCreateAccount, parseWithdrawal } from './validation';

/** Express 4 does not forward rejected promises to the error middleware; this does. */
const asyncHandler =
  (handler: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next) => {
    handler(req, res).catch(next);
  };

export const router = Router();

router.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

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
    const { transaction, replayed } = await withdraw(accountId, parseWithdrawal(req.body));

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
  }),
);

router.get(
  '/accounts/:id/transactions',
  asyncHandler(async (req, res) => {
    const transactions = await listTransactions(parseAccountId(req.params.id));
    res.status(200).json({ transactions: transactions.map(toTransaction) });
  }),
);

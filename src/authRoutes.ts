// The surface the browser talks to. Its defining property is that it takes no account id:
// identity comes from the session cookie, so the UI never holds -- and can never be talked
// into sending -- somebody else's account id.
import { Router, type Request, type RequestHandler, type Response } from 'express';
import { ApiError } from './errors';
import { googleClientId, issueNonce, verifyGoogleIdToken } from './googleAuth';
import { toAccount, toTransaction, toUser } from './models';
import { sendWithdrawal } from './routes';
import {
  clearSessionCookie,
  mintSession,
  readCookie,
  readSession,
  SESSION_COOKIE,
  setSessionCookie,
  type Session,
} from './session';
import { getAccount, listTransactions, withdraw } from './service';
import { findIdentity, signIn } from './users';
import { parseWithdrawal } from './validation';

const asyncHandler =
  (handler: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next) => {
    handler(req, res).catch(next);
  };

/** The session behind a request, or a 401. Every /me route starts here. */
function requireSession(req: Request): Session {
  const session = readSession(readCookie(req.headers.cookie, SESSION_COOKIE));
  if (!session) {
    throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in to continue.');
  }
  return session;
}

export const authRouter = Router();

/**
 * What the sign-in page needs before it can render Google's button: the client id, and a
 * nonce to hand to Google. Google echoes the nonce back inside the ID token, which is what
 * stops a token minted for another site -- or captured from an earlier sign-in -- from
 * being replayed here. It is an HMAC over its own timestamp, so it needs no server state.
 */
authRouter.get('/auth/config', (_req, res) => {
  const clientId = googleClientId();
  res.json({
    clientId: clientId ?? null,
    configured: clientId !== undefined,
    nonce: issueNonce(),
  });
});

authRouter.post(
  '/auth/google',
  asyncHandler(async (req, res) => {
    const body: unknown = req.body;
    const credential = typeof body === 'object' && body !== null ? (body as { credential?: unknown }).credential : undefined;

    // Nothing below this line runs on an unproven token: verify throws unless the signature,
    // the issuer, the audience, the expiry, the nonce and email_verified all check out.
    const profile = await verifyGoogleIdToken(credential);
    const { user, account } = await signIn(profile);

    setSessionCookie(res, mintSession(user.id, account.id));
    res.status(200).json({ user: toUser(user), account: toAccount(account) });
  }),
);

// Clearing the cookie is the whole of sign-out on this side; the browser also has to tell
// Google to stop auto-selecting the account, which app.js does.
authRouter.post('/auth/logout', (_req, res) => {
  clearSessionCookie(res);
  res.status(204).end();
});

authRouter.get(
  '/me',
  asyncHandler(async (req, res) => {
    const identity = await findIdentity(requireSession(req).userId);
    if (!identity) {
      // The cookie outlived the user it names. Clearing it stops the UI from looping.
      clearSessionCookie(res);
      throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in to continue.');
    }
    res.json({ user: toUser(identity.user), account: toAccount(identity.account) });
  }),
);

authRouter.get(
  '/me/account',
  asyncHandler(async (req, res) => {
    res.json(toAccount(await getAccount(requireSession(req).accountId)));
  }),
);

authRouter.get(
  '/me/transactions',
  asyncHandler(async (req, res) => {
    const transactions = await listTransactions(requireSession(req).accountId);
    res.json({ transactions: transactions.map(toTransaction) });
  }),
);

// Same validation, same service call, same responses as POST /accounts/:id/withdraw --
// only the account id comes from the session rather than the URL.
authRouter.post(
  '/me/withdraw',
  asyncHandler(async (req, res) => {
    const session = requireSession(req);
    sendWithdrawal(res, await withdraw(session.accountId, parseWithdrawal(req.body)));
  }),
);

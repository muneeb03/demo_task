// Sessions are a signed cookie rather than a row in a table: the payload is small, fixed,
// and self-expiring, so a database round trip per request would buy nothing. Signing uses
// node:crypto, which is why the whole auth layer adds no dependency.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Response } from 'express';

export const SESSION_COOKIE = 'ledger_session';
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

/** What a valid cookie proves: which user is calling, and which account is theirs. */
export interface Session {
  userId: string;
  accountId: string;
  /** Unix seconds. */
  expiresAt: number;
}

// A generated secret means sessions simply do not survive a restart, which is the right
// failure for a demo -- far better than shipping a hard-coded default that reaches production.
const secret: Buffer = (() => {
  const configured = process.env.SESSION_SECRET?.trim();
  if (configured) {
    return Buffer.from(configured, 'utf8');
  }
  if (process.env.NODE_ENV !== 'test') {
    console.warn('[auth] SESSION_SECRET is not set; using a random one. Sessions end at restart.');
  }
  return randomBytes(32);
})();

// Off by default because the demo runs on http://localhost, where a Secure cookie is
// silently dropped. Anything served over HTTPS must turn it on.
const cookieIsSecure = process.env.SESSION_COOKIE_SECURE === 'true';

if (process.env.NODE_ENV === 'production' && !cookieIsSecure) {
  console.warn('[auth] NODE_ENV=production without SESSION_COOKIE_SECURE=true; set it behind HTTPS.');
}

const sign = (payload: string): string =>
  createHmac('sha256', secret).update(payload).digest('base64url');

/** Constant-time comparison that does not leak the length of the expected value. */
const signatureMatches = (expected: string, actual: string): boolean => {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(actual, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
};

export function mintSession(userId: string, accountId: string): string {
  const session: Session = {
    userId,
    accountId,
    expiresAt: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
  };
  const payload = Buffer.from(JSON.stringify(session), 'utf8').toString('base64url');
  return `${payload}.${sign(payload)}`;
}

/** Returns the session a token carries, or undefined if it is forged, damaged or expired. */
export function readSession(token: string | undefined): Session | undefined {
  if (!token) {
    return undefined;
  }

  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) {
    return undefined;
  }

  const payload = token.slice(0, dot);
  if (!signatureMatches(sign(payload), token.slice(dot + 1))) {
    return undefined;
  }

  // The signature already proves we wrote this, so a parse failure here means a bug on our
  // side rather than an attack -- either way the caller is simply not signed in.
  let session: Session;
  try {
    session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Session;
  } catch {
    return undefined;
  }

  if (
    typeof session?.userId !== 'string' ||
    typeof session?.accountId !== 'string' ||
    typeof session?.expiresAt !== 'number' ||
    session.expiresAt <= Math.floor(Date.now() / 1000)
  ) {
    return undefined;
  }

  return session;
}

/** Reads one cookie out of a raw `Cookie` header, so cookie-parser is not needed. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) {
    return undefined;
  }
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) {
      continue;
    }
    if (part.slice(0, eq).trim() === name) {
      const raw = part.slice(eq + 1).trim();
      try {
        return decodeURIComponent(raw);
      } catch {
        // A value with a broken percent-escape cannot be one we issued, since we
        // write it with encodeURIComponent. Returning it undecoded lets
        // readSession reject it as a bad signature -- a 401 -- rather than
        // letting a URIError escape and become a 500.
        return raw;
      }
    }
  }
  return undefined;
}

const serialize = (value: string, maxAge: number): string =>
  [
    `${SESSION_COOKIE}=${encodeURIComponent(value)}`,
    'Path=/',
    // HttpOnly keeps the token away from any script on the page; SameSite=Lax means a
    // cross-site POST -- the shape a CSRF attempt takes -- arrives without it.
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
    ...(cookieIsSecure ? ['Secure'] : []),
  ].join('; ');

export const setSessionCookie = (res: Response, token: string): void => {
  res.setHeader('Set-Cookie', serialize(token, SESSION_TTL_SECONDS));
};

export const clearSessionCookie = (res: Response): void => {
  res.setHeader('Set-Cookie', serialize('', 0));
};

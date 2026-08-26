// Verifies a Google ID token from first principles, using only node:crypto and fetch.
// A library would do the same three things: fetch Google's public keys, check the RS256
// signature, and check every claim. Doing it here keeps the dependency list at two.
import { createHmac, createPublicKey, timingSafeEqual, verify, type KeyObject } from 'node:crypto';
import { ApiError } from './errors';

const JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';

// Google still mints tokens under the bare host as well as the https form; both are legitimate.
const ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);

// The conventional allowance. Container clocks drift, and rejecting a genuine token
// because of five seconds of skew is a worse failure than honouring one five minutes late.
const CLOCK_SKEW_SECONDS = 300;
const MIN_JWKS_TTL_MS = 60_000;
const MAX_JWKS_TTL_MS = 24 * 60 * 60 * 1000;
// A token naming an unknown key forces a refetch; this is the floor between two of them, so
// a flood of junk tokens cannot turn into a flood of requests to Google.
const REFRESH_COOLDOWN_MS = 60_000;

const NONCE_TTL_SECONDS = 60 * 60;

/** The claims we actually use, once the token has been proven genuine. */
export interface GoogleProfile {
  sub: string;
  email: string;
  name: string;
  picture: string | null;
}

export const googleClientId = (): string | undefined => {
  const configured = process.env.GOOGLE_CLIENT_ID?.trim();
  return configured ? configured : undefined;
};

const invalid = (message: string): ApiError => new ApiError(401, 'INVALID_CREDENTIAL', message);

// ---------------------------------------------------------------------------
// Sign-in nonce
//
// Google echoes this back inside the ID token, which is what stops a token minted for some
// other site from being replayed against this one. It is derived rather than stored, so it
// costs no state: the timestamp travels in the clear and the HMAC is what makes it ours.
// ---------------------------------------------------------------------------

const nonceSecret = (): string => process.env.SESSION_SECRET?.trim() || 'ledger-nonce';

const nonceSignature = (issuedAt: string): string =>
  createHmac('sha256', nonceSecret()).update(`nonce:${issuedAt}`).digest('base64url');

export function issueNonce(): string {
  const issuedAt = String(Math.floor(Date.now() / 1000));
  return `${issuedAt}.${nonceSignature(issuedAt)}`;
}

function assertNonceIsOurs(nonce: unknown): void {
  if (typeof nonce !== 'string') {
    throw new ApiError(401, 'NONCE_INVALID', 'Sign-in nonce is missing. Reload the page and try again.');
  }

  const dot = nonce.indexOf('.');
  const issuedAt = dot === -1 ? '' : nonce.slice(0, dot);
  const expected = Buffer.from(nonceSignature(issuedAt), 'utf8');
  const actual = Buffer.from(nonce.slice(dot + 1), 'utf8');

  const wellFormed = /^\d+$/.test(issuedAt);
  if (!wellFormed || expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new ApiError(401, 'NONCE_INVALID', 'Sign-in nonce is not valid. Reload the page and try again.');
  }

  if (Number(issuedAt) + NONCE_TTL_SECONDS < Math.floor(Date.now() / 1000)) {
    throw new ApiError(401, 'NONCE_INVALID', 'Sign-in nonce has expired. Reload the page and try again.');
  }
}

// ---------------------------------------------------------------------------
// Google's signing keys
// ---------------------------------------------------------------------------

interface Jwks {
  keys: Map<string, KeyObject>;
  expiresAt: number;
}

let cached: Jwks | undefined;
// One in-flight fetch is shared by every concurrent sign-in, so a cold cache under load
// makes a single request to Google rather than one per request.
let inFlight: Promise<Jwks> | undefined;
let lastFetchedAt = 0;

async function fetchJwks(): Promise<Jwks> {
  const res = await fetch(JWKS_URL);
  if (!res.ok) {
    throw new ApiError(503, 'GOOGLE_KEYS_UNAVAILABLE', "Could not reach Google's signing keys.");
  }

  const body = (await res.json()) as { keys?: Array<Record<string, unknown>> };
  const keys = new Map<string, KeyObject>();

  for (const jwk of body.keys ?? []) {
    if (typeof jwk.kid !== 'string' || jwk.kty !== 'RSA') {
      continue;
    }
    try {
      keys.set(jwk.kid, createPublicKey({ key: jwk as never, format: 'jwk' }));
    } catch {
      // One unusable key must not take the whole key set down with it.
    }
  }

  if (keys.size === 0) {
    throw new ApiError(503, 'GOOGLE_KEYS_UNAVAILABLE', "Google's key set was empty.");
  }

  // Google publishes a real max-age (hours, not seconds); honouring it is why this cache
  // almost never has to ask again.
  const maxAge = /max-age=(\d+)/i.exec(res.headers.get('cache-control') ?? '')?.[1];
  const ttl = Math.min(Math.max(Number(maxAge ?? 0) * 1000, MIN_JWKS_TTL_MS), MAX_JWKS_TTL_MS);

  lastFetchedAt = Date.now();
  return { keys, expiresAt: Date.now() + ttl };
}

async function loadJwks(): Promise<Jwks> {
  inFlight ??= fetchJwks()
    .then((jwks) => {
      cached = jwks;
      return jwks;
    })
    .finally(() => {
      inFlight = undefined;
    });
  return inFlight;
}

async function signingKey(kid: string): Promise<KeyObject> {
  const fresh = cached && cached.expiresAt > Date.now() ? cached : await loadJwks();

  const key = fresh.keys.get(kid);
  if (key) {
    return key;
  }

  // An unknown kid usually means Google rotated its keys early, so it is worth one refetch --
  // but only one, and only outside the cooldown.
  if (Date.now() - lastFetchedAt < REFRESH_COOLDOWN_MS) {
    throw invalid('Credential was signed with an unrecognised key.');
  }

  const rotated = await loadJwks();
  const rotatedKey = rotated.keys.get(kid);
  if (!rotatedKey) {
    throw invalid('Credential was signed with an unrecognised key.');
  }
  return rotatedKey;
}

// ---------------------------------------------------------------------------
// The token itself
// ---------------------------------------------------------------------------

function decodeSegment(segment: string, what: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
  } catch {
    throw invalid(`Credential ${what} is not valid JSON.`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw invalid(`Credential ${what} is not an object.`);
  }
  return parsed as Record<string, unknown>;
}

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

/**
 * Proves a Google ID token is genuine and returns the profile it carries.
 *
 * Signature first, claims second: a token whose signature does not check out is not worth
 * reading, and reading it first would mean trusting attacker-controlled fields.
 */
export async function verifyGoogleIdToken(credential: unknown): Promise<GoogleProfile> {
  const clientId = googleClientId();
  if (!clientId) {
    throw new ApiError(
      503,
      'GOOGLE_AUTH_UNCONFIGURED',
      'Google sign-in is not configured on this server. Set GOOGLE_CLIENT_ID.',
    );
  }

  if (typeof credential !== 'string' || credential.length === 0) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'credential is required and must be a string.', [
      { field: 'credential', message: 'credential is required and must be a string.' },
    ]);
  }

  const parts = credential.split('.');
  const [rawHeader, rawPayload, rawSignature] = parts;
  if (parts.length !== 3 || !rawHeader || !rawPayload || !rawSignature) {
    throw invalid('Credential is not a well-formed JWT.');
  }

  const header = decodeSegment(rawHeader, 'header');
  // Pinned to RS256. Accepting whatever the header asks for is how the classic "alg: none"
  // and HMAC-confusion attacks work.
  if (header.alg !== 'RS256') {
    throw invalid('Credential must be signed with RS256.');
  }
  const kid = asString(header.kid);
  if (!kid) {
    throw invalid('Credential header is missing a key id.');
  }

  const signatureIsGood = verify(
    'RSA-SHA256',
    Buffer.from(`${rawHeader}.${rawPayload}`, 'utf8'),
    await signingKey(kid),
    Buffer.from(rawSignature, 'base64url'),
  );
  if (!signatureIsGood) {
    throw invalid('Credential signature does not verify.');
  }

  const claims = decodeSegment(rawPayload, 'payload');
  const now = Math.floor(Date.now() / 1000);

  if (typeof claims.iss !== 'string' || !ISSUERS.has(claims.iss)) {
    throw invalid('Credential was not issued by Google.');
  }

  // The single most dangerous check to omit: without it, a perfectly valid Google token
  // minted for any other application in the world is accepted as one of ours. `aud` is
  // usually a string but is permitted to be an array, so membership rather than equality.
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(clientId)) {
    throw invalid('Credential was issued for a different application.');
  }
  // azp names the party the token was actually handed to; if it disagrees with aud, the
  // token is being relayed by someone.
  if (claims.azp !== undefined && claims.azp !== clientId) {
    throw invalid('Credential was issued to a different party.');
  }

  if (typeof claims.exp !== 'number' || claims.exp + CLOCK_SKEW_SECONDS < now) {
    throw invalid('Credential has expired.');
  }
  if (typeof claims.iat === 'number' && claims.iat - CLOCK_SKEW_SECONDS > now) {
    throw invalid('Credential was issued in the future.');
  }
  if (typeof claims.nbf === 'number' && claims.nbf - CLOCK_SKEW_SECONDS > now) {
    throw invalid('Credential is not valid yet.');
  }

  assertNonceIsOurs(claims.nonce);

  const sub = asString(claims.sub);
  const email = asString(claims.email);
  if (!sub || !email) {
    throw invalid('Credential is missing the subject or email claim.');
  }
  // An unverified address could belong to anyone, so it cannot be an identity.
  if (claims.email_verified !== true) {
    throw invalid('The Google account email address is not verified.');
  }

  return {
    sub,
    email,
    name: asString(claims.name) ?? email.split('@')[0] ?? email,
    picture: asString(claims.picture) ?? null,
  };
}

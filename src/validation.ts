import { ApiError } from './errors';

/**
 * Simplified format checks (no checksum verification):
 *  - TRC20: "T" + 33 base58 characters (base58 excludes 0, O, I and l)
 *  - ERC20: "0x" + 40 hex characters
 */
export const ADDRESS_PATTERNS = {
  TRC20: /^T[1-9A-HJ-NP-Za-km-z]{33}$/,
  ERC20: /^0x[a-fA-F0-9]{40}$/,
} as const;

export type Network = keyof typeof ADDRESS_PATTERNS;

export const NETWORKS = Object.keys(ADDRESS_PATTERNS) as Network[];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_OWNER_LENGTH = 200;
const MAX_IDEMPOTENCY_KEY_LENGTH = 255;

export interface FieldError {
  field: string;
  message: string;
}

export interface CreateAccountInput {
  owner: string;
  /** Decimal string handed straight to Postgres `numeric`. */
  balance: string;
}

export interface WithdrawalInput {
  amount: string;
  address: string;
  network: Network;
  idempotencyKey: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const assertNoErrors = (errors: FieldError[]): void => {
  if (errors.length > 0) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Request body failed validation.', errors);
  }
};

/** Path parameters are validated before they reach the database. */
export function parseAccountId(raw: string | undefined): string {
  if (typeof raw !== 'string' || !UUID_RE.test(raw)) {
    throw new ApiError(400, 'INVALID_ACCOUNT_ID', 'Account id must be a UUID.');
  }
  return raw;
}

export function parseCreateAccount(body: unknown): CreateAccountInput {
  if (!isRecord(body)) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Request body must be a JSON object.');
  }

  const errors: FieldError[] = [];
  const { owner, balance } = body;

  if (typeof owner !== 'string' || owner.trim().length === 0) {
    errors.push({ field: 'owner', message: 'owner is required and must be a non-empty string.' });
  } else if (owner.trim().length > MAX_OWNER_LENGTH) {
    errors.push({ field: 'owner', message: `owner must be at most ${MAX_OWNER_LENGTH} characters.` });
  }

  // balance is optional and defaults to 0; when present it must be a finite, non-negative number.
  if (balance !== undefined && (typeof balance !== 'number' || !Number.isFinite(balance) || balance < 0)) {
    errors.push({ field: 'balance', message: 'balance must be a finite number greater than or equal to 0.' });
  }

  assertNoErrors(errors);

  return {
    owner: (owner as string).trim(),
    balance: balance === undefined ? '0' : String(balance),
  };
}

export function parseWithdrawal(body: unknown): WithdrawalInput {
  if (!isRecord(body)) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Request body must be a JSON object.');
  }

  const errors: FieldError[] = [];
  const { amount, address, network, idempotencyKey } = body;

  if (typeof amount !== 'number' || !Number.isFinite(amount)) {
    errors.push({ field: 'amount', message: 'amount is required and must be a finite number.' });
  } else if (amount <= 0) {
    errors.push({ field: 'amount', message: 'amount must be greater than 0.' });
  }

  if (typeof address !== 'string' || address.length === 0) {
    errors.push({ field: 'address', message: 'address is required and must be a non-empty string.' });
  }

  const networkIsValid = typeof network === 'string' && (NETWORKS as string[]).includes(network);
  if (!networkIsValid) {
    errors.push({ field: 'network', message: `network must be one of: ${NETWORKS.join(', ')}.` });
  }

  // The address is only meaningful relative to a known network, so check the pair together.
  if (networkIsValid && typeof address === 'string' && address.length > 0) {
    const pattern = ADDRESS_PATTERNS[network as Network];
    if (!pattern.test(address)) {
      errors.push({
        field: 'address',
        message: `address is not a valid ${network} address.`,
      });
    }
  }

  if (typeof idempotencyKey !== 'string' || idempotencyKey.trim().length === 0) {
    errors.push({
      field: 'idempotencyKey',
      message: 'idempotencyKey is required and must be a non-empty string.',
    });
  } else if (idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    errors.push({
      field: 'idempotencyKey',
      message: `idempotencyKey must be at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters.`,
    });
  }

  assertNoErrors(errors);

  return {
    amount: String(amount),
    address: address as string,
    network: network as Network,
    idempotencyKey: (idempotencyKey as string).trim(),
  };
}

/* ============================================================================
   Crypto Ledger — the browser half.

   Two rules run through everything below.

   1. Money that came from the server is a STRING and is never passed through
      Number(), parseFloat() or Intl.NumberFormat. `numeric` columns exist so
      balances do not round, and re-rounding them in the browser would give all
      of that back. The one place Number() is correct is the amount the user
      typed, because the API takes `amount` as a JSON number — and even there
      the value is checked for a lossless round trip before it is sent.

   2. Feedback branches on `error.code`, never on the HTTP status. A 409 is
      three different things here, and only one of them is about funds.
   ========================================================================= */

'use strict';

const UNIT = 'USDT';

// The same checks the server runs, so a malformed address costs no round trip.
const NETWORKS = {
  TRC20: { re: /^T[1-9A-HJ-NP-Za-km-z]{33}$/, len: 34, hint: '34 characters · base58, begins T' },
  ERC20: { re: /^0x[a-fA-F0-9]{40}$/, len: 42, hint: '42 characters · 0x followed by 40 hex' },
};

const $ = (id) => document.getElementById(id);
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
const announce = (message) => { $('live').textContent = message; };

/* -------------------------------------------------------------- transport -- */

/** One fetch wrapper, so every caller sees the same {ok, status, code, body}. */
async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  let parsed = null;
  if (res.status !== 204) {
    try { parsed = await res.json(); } catch { parsed = null; }
  }

  return {
    ok: res.ok,
    status: res.status,
    body: parsed,
    code: parsed && parsed.error ? parsed.error.code : undefined,
    message: parsed && parsed.error ? parsed.error.message : undefined,
    details: parsed && parsed.error ? parsed.error.details : undefined,
    // The proof that a repeated request was answered from storage rather than run twice.
    replayed: res.headers.get('Idempotent-Replay') === 'true',
  };
}

/* ----------------------------------------------------------------- money -- */

/**
 * Splits an exact decimal string into the parts the ledger renders separately.
 *
 * Everything here is string surgery. `pad` is the digits we add to reach two
 * decimal places — they are rendered ghosted, because "0.2" and "0.20" are
 * different facts and a digit the server never sent must not be printed in the
 * same ink as one it did.
 */
function splitAmount(value) {
  const text = String(value);
  const negative = text.startsWith('-');
  const [rawInt = '0', rawFrac = ''] = (negative ? text.slice(1) : text).split('.');

  const grouped = rawInt.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const sent = rawFrac.slice(0, 2);
  const pad = '0'.repeat(2 - sent.length);

  // Beyond two decimals the digits are real but secondary. Four fit the cell;
  // past that the figure is elided on screen and kept whole for assistive tech.
  const rest = rawFrac.slice(2);
  const tail = rest.length > 4 ? `${rest.slice(0, 3)}…` : rest;

  return { sign: negative ? '-' : '', int: grouped, sent, pad, tail, exact: text };
}

/** The amount cell: two fixed-width halves whose boundary is the decimal axis. */
function renderAmount(value, { sign = '' } = {}) {
  const parts = splitAmount(value);
  const node = el('span', 'amt');
  node.append(el('span', 'amt__int', `${sign}${parts.sign}${parts.int}`));

  const frac = el('span', 'amt__frac');
  frac.append(document.createTextNode('.'), el('span', null, parts.sent));
  if (parts.pad) frac.append(el('span', 'amt__pad', parts.pad));
  if (parts.tail) frac.append(el('span', 'amt__tail', parts.tail));
  node.append(frac);

  node.append(el('span', 'sr-only', ` ${parts.exact} ${UNIT}`));
  return node;
}

const shortAddress = (address) =>
  address.length > 14 ? `${address.slice(0, 6)}…${address.slice(-6)}` : address;

const stamp = (iso) => {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return {
    day: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`,
    time: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`,
  };
};

/* ----------------------------------------------------------------- state -- */

const state = {
  account: null,
  transactions: [],
  /** Minted when the form is first touched and reused for every retry of the
   *  same attempt, so a resend after a dropped connection replays rather than
   *  charging twice. Cleared once an attempt is recorded. */
  idempotencyKey: null,
};

const show = (view) => {
  $('view-signin').hidden = view !== 'signin';
  $('view-app').hidden = view !== 'app';
};

/* ---------------------------------------------------------------- notices -- */

const TONES = {
  success: ['var(--success)', 'var(--success-wash)'],
  danger: ['var(--danger)', 'var(--danger-wash)'],
  accent: ['var(--accent)', 'var(--accent-wash)'],
};

/** A block above the form, where the action was taken. It never auto-dismisses:
 *  a confirmation about money should not evaporate. */
function notice(tone, title, body, chip) {
  const box = $('notice');
  const [line, wash] = TONES[tone];
  box.style.setProperty('--tone', line);
  box.style.setProperty('--tone-wash', wash);

  box.replaceChildren();
  box.append(el('p', 'notice__title', title));
  if (body) box.append(el('p', 'notice__body', body));
  if (chip) box.append(el('span', 'chip', chip));

  $('notice-slot').classList.add('is-open');
  announce(`${title}. ${body || ''}`);
}

const clearNotice = () => {
  $('notice-slot').classList.remove('is-open');
  $('notice').replaceChildren();
};

/* ------------------------------------------------------------ field errors -- */

const FIELDS = ['amount', 'network', 'address'];

function clearErrors() {
  for (const field of FIELDS) {
    const target = $(`err-${field}`);
    target.hidden = true;
    target.textContent = '';
    const input = $(field);
    if (input) {
      input.removeAttribute('aria-invalid');
      // Left in place, this keeps the old message in the field's accessible
      // description long after the message itself is gone from the screen.
      input.removeAttribute('aria-describedby');
    }
  }
}

/** Routes the server's `details` by field name. Anything with no visible input
 *  of its own — `idempotencyKey`, most of all — goes to the notice rather than
 *  being swallowed. */
function showErrors(details, fallbackMessage) {
  clearErrors();
  const orphans = [];
  let firstInvalid = null;

  for (const detail of details || []) {
    const target = $(`err-${detail.field}`);
    if (!target) {
      orphans.push(`${detail.field}: ${detail.message}`);
      continue;
    }
    target.textContent = detail.message;
    target.hidden = false;

    const input = $(detail.field);
    if (input) {
      input.setAttribute('aria-invalid', 'true');
      input.setAttribute('aria-describedby', `err-${detail.field}`);
      firstInvalid = firstInvalid || input;
    }
  }

  const unexplained = orphans.join(' · ') || fallbackMessage;
  if (unexplained) {
    notice('danger', 'Request rejected', unexplained);
  }

  // Moving focus is not an announcement: if the invalid field is already focused
  // — the common case, since that is where the user just typed — nothing is read
  // out at all. Say it explicitly instead of relying on the focus move.
  const spoken = (details || []).map((detail) => detail.message).join(' ');
  if (spoken) announce(`Withdrawal not sent. ${spoken}`);

  if (firstInvalid) firstInvalid.focus();
}

/* -------------------------------------------------------------- rendering -- */

function renderAccount(account, { remark = false } = {}) {
  state.account = account;

  const balance = $('balance');
  balance.replaceChildren(renderAmount(account.balance), el('span', 'hero__unit', UNIT));
  balance.setAttribute('aria-label', `Available balance ${account.balance} ${UNIT}`);

  $('account-id').textContent = `${account.id.slice(0, 8)}…${account.id.slice(-4)}`;

  // Stamped with the moment it was actually read, and re-stamped only when it is
  // read again. A clock ticking beside a number fetched once implies a re-read
  // that is not happening.
  const now = new Date();
  const read = stamp(now.toISOString());
  const asOf = $('as-of');
  asOf.textContent = `${read.day} · ${read.time} UTC`;
  asOf.setAttribute('datetime', now.toISOString());

  if (remark) {
    const hero = document.querySelector('.hero');
    hero.classList.remove('is-remarked');
    void hero.offsetWidth;                        // restart the animation
    hero.classList.add('is-remarked');
  }
}

// Banking words. "Declined" says what a failed withdrawal is far better than
// "failed", which reads like the request itself broke.
const STATUS_WORDS = { completed: 'Cleared', failed: 'Declined', pending: 'Pending' };

function renderTransactions(transactions) {
  state.transactions = transactions;

  const list = $('tx-list');
  list.replaceChildren();

  $('tx-count').textContent = transactions.length
    ? `${transactions.length} ${transactions.length === 1 ? 'entry' : 'entries'}`
    : '';
  $('tx-empty').hidden = transactions.length > 0;

  let previousDay = null;

  for (const tx of transactions) {
    const when = stamp(tx.createdAt);
    const row = el('li', `ledger__row ledger__row--${tx.status}`);
    row.dataset.id = tx.id;

    // A ditto mark where the day repeats: sixty rows of the same date is the
    // noise this design's hairline discipline exists to prevent.
    const repeated = when.day === previousDay;
    previousDay = when.day;

    const time = el('time', 'tx__when');
    time.setAttribute('datetime', tx.createdAt);
    time.append(repeated ? '〃 ' : `${when.day} `, when.time);
    if (repeated) time.append(el('span', 'sr-only', ` ${when.day}`));

    const dest = el('span', 'tx__dest');
    const addr = el('span', 'tx__addr', shortAddress(tx.address));
    addr.append(el('span', 'sr-only', ` full address ${tx.address}`));
    dest.append(addr, el('span', 'badge', tx.network));

    const status = el('span', `status status--${tx.status}`, STATUS_WORDS[tx.status] || tx.status);
    if (tx.status === 'failed') status.append(el('span', 'sr-only', ' — no funds moved'));

    // Only a completed withdrawal actually moved money, so only it carries a sign.
    row.append(time, dest, status, renderAmount(tx.amount, { sign: tx.status === 'completed' ? '−' : '' }));
    list.append(row);
  }
}


/* --------------------------------------------------------------- the form -- */

const selectedNetwork = () => document.querySelector('input[name="network"]:checked').value;

function syncNetwork() {
  const network = NETWORKS[selectedNetwork()];
  $('hint').textContent = network.hint;
  $('address').maxLength = network.len;
  $('address').placeholder = selectedNetwork() === 'TRC20' ? 'T…' : '0x…';
  syncCounter();
}

function syncCounter() {
  const network = NETWORKS[selectedNetwork()];
  const counter = $('counter');
  counter.textContent = `${$('address').value.length} / ${network.len}`;
  counter.classList.toggle('is-met', $('address').value.length === network.len);
}

/**
 * Strips the parts of a decimal string that carry no value, so two spellings of
 * the same number compare equal: "10.50", "+10.5" and "010.500" all become
 * "10.5". Used to ask whether a typed amount survived a round trip through a
 * double -- a question about value, not about spelling.
 */
/** String(1e-7) is "1e-7", which no decimal comparison can read. This is the
 *  same number written the way the user would have typed it. */
const asPlainDecimal = (value) =>
  value.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 20 });

function normalizeDecimal(text) {
  let rest = text.replace(/^\+/, '');
  const negative = rest.startsWith('-');
  if (negative) rest = rest.slice(1);

  const [whole = '', fraction = ''] = rest.split('.');
  const int = whole.replace(/^0+/, '') || '0';
  const frac = fraction.replace(/0+$/, '');
  return `${negative ? '-' : ''}${int}${frac ? `.${frac}` : ''}`;
}

/** Everything the server would reject, caught here first — plus the one thing
 *  it cannot check: that the number we are about to send is exactly the number
 *  that was typed. */
function validate() {
  const details = [];
  const raw = $('amount').value.trim();
  const amount = Number(raw);

  if (raw === '') {
    details.push({ field: 'amount', message: 'Enter an amount.' });
  } else if (!/^\d*\.?\d*$/.test(raw) || !/\d/.test(raw)) {
    details.push({ field: 'amount', message: 'Amount must be a plain decimal number.' });
  } else if (!(amount > 0)) {
    details.push({ field: 'amount', message: 'Amount must be greater than 0.' });
  } else if (normalizeDecimal(raw) !== normalizeDecimal(asPlainDecimal(amount))) {
    // JSON numbers are IEEE-754 doubles, and the API takes `amount` as a number.
    // If the typed value does not survive that trip intact, sending it would
    // move a different amount than the one on screen, so it is refused rather
    // than silently altered. Trailing zeros are fine -- only value matters here.
    details.push({ field: 'amount', message: `Too many digits to send exactly. The nearest value a JSON number holds is ${asPlainDecimal(amount)}.` });
  }

  const address = $('address').value.trim();
  const network = NETWORKS[selectedNetwork()];
  if (!address) {
    details.push({ field: 'address', message: 'Enter a destination address.' });
  } else if (!network.re.test(address)) {
    details.push({ field: 'address', message: `Not a valid ${selectedNetwork()} address — ${network.hint}.` });
  }

  return { details, amount, address };
}

async function submit(event) {
  event.preventDefault();
  clearErrors();

  const { details, amount, address } = validate();
  if (details.length) {
    showErrors(details);
    return;
  }

  state.idempotencyKey = state.idempotencyKey || crypto.randomUUID();

  const button = $('submit');
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');

  // Only the request itself belongs in this try. Rendering the outcome must not
  // be able to fail its way into a "could not reach the server" message about a
  // withdrawal the server has already recorded.
  let res;
  try {
    res = await api('POST', '/me/withdraw', {
      amount,
      address,
      network: selectedNetwork(),
      idempotencyKey: state.idempotencyKey,
    });
  } catch {
    // A reply that never arrived looks exactly like a request that never landed,
    // so this deliberately does not claim which happened. The key is kept, which
    // is what makes resubmitting safe: it replays rather than charging again.
    notice(
      'danger',
      'No reply from the server',
      'The withdrawal may or may not have been recorded. Submitting again reuses the same idempotency key, so it cannot be charged twice.',
    );
    return;
  } finally {
    button.disabled = false;
    button.removeAttribute('aria-busy');
  }

  await handleWithdrawal(res, address);
}

async function handleWithdrawal(res, address) {
  // A withdrawal that was recorded -- cleared or declined -- ends this attempt,
  // so the next one gets a key of its own.
  const recorded = res.ok || res.code === 'INSUFFICIENT_FUNDS';
  if (recorded) state.idempotencyKey = null;

  if (res.ok) {
    const tx = res.body;
    const when = stamp(tx.createdAt);

    if (res.replayed) {
      notice(
        'accent',
        'Original result returned',
        `This key already recorded ${tx.amount} ${UNIT} to ${shortAddress(tx.address)} at ${when.time} UTC. Nothing was charged twice.`,
        'Idempotent-Replay: true',
      );
    } else {
      notice('success', 'Withdrawal recorded', `−${tx.amount} ${UNIT} · ${tx.network} · ${shortAddress(tx.address)} · ${when.time} UTC`);
      $('amount').value = '';
      $('address').value = '';
      syncCounter();
    }

    if (!(await refresh({ remark: !res.replayed }))) {
      noticeAddendum('The balance above could not be re-read. Reload to see it.');
    }
    if (res.replayed) recall(tx.id);
    return;
  }

  if (res.code === 'INSUFFICIENT_FUNDS') {
    // The server deliberately omits the live balance so a replayed 409 is
    // byte-for-byte identical; pairing one with a separately fetched balance
    // would print a sentence that was never true. Its message, and the record.
    notice('danger', 'Declined — insufficient funds', `${res.message} The attempt is on the ledger below.`);
    await refresh();

    const recorded409 = res.body && res.body.error && res.body.error.transaction;
    if (recorded409) recall(recorded409.id);
    return;
  }

  if (res.code === 'IDEMPOTENCY_KEY_REUSED' || res.code === 'IDEMPOTENCY_CONFLICT') {
    state.idempotencyKey = null;
    notice('accent', 'Idempotency key in use', res.message, `Code: ${res.code}`);
    return;
  }

  if (res.code === 'VALIDATION_ERROR') {
    showErrors(res.details, res.message);
    return;
  }

  if (res.status === 401) {
    await sessionEnded();
    return;
  }

  notice('danger', 'Withdrawal failed', res.message || `The server answered ${res.status}.`);
}

/** Points at a row that already existed rather than announcing it in prose. */
function recall(id) {
  const row = $('tx-list').querySelector(`[data-id="${id}"]`);
  if (!row) return;
  row.classList.add('ledger__row--recalled');
  row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

/** Re-reads the account and its history. Returns false if it could not, which
 *  the caller reports next to the outcome rather than in place of it. */
async function refresh(options) {
  try {
    const [account, history] = await Promise.all([
      api('GET', '/me/account'),
      api('GET', '/me/transactions'),
    ]);
    if (account.ok) renderAccount(account.body, options);
    if (history.ok) renderTransactions(history.body.transactions);
    return account.ok && history.ok;
  } catch {
    return false;
  }
}

/** Adds a line to the notice already on screen, without disturbing it. */
function noticeAddendum(text) {
  if ($('notice-slot').classList.contains('is-open')) {
    $('notice').append(el('p', 'notice__body', text));
  }
  announce(text);
}

/* ------------------------------------------------------------------ user -- */

function renderUser(user) {
  $('user-name').textContent = user.name;

  const avatar = $('avatar');
  avatar.replaceChildren();
  avatar.style.backgroundImage = '';
  if (user.picture) {
    const img = new Image();
    img.referrerPolicy = 'no-referrer';
    // Painted only once it has actually loaded, so a 404 leaves the initial
    // showing rather than an empty square.
    img.onload = () => { avatar.style.backgroundImage = `url("${user.picture}")`; avatar.replaceChildren(); };
    img.src = user.picture;
  }
  avatar.append(el('span', null, (user.name || user.email || '?').trim().charAt(0).toUpperCase()));
  avatar.setAttribute('title', user.email);
}

async function enter(identity) {
  renderUser(identity.user);
  renderAccount(identity.account);
  show('app');
  const history = await api('GET', '/me/transactions');
  if (history.ok) renderTransactions(history.body.transactions);
}

/**
 * The session went away underneath us — it expired, or the server restarted with
 * a new secret. Revealing #view-signin is not enough: on a page that booted
 * signed in, Google's script was never loaded and the button slot is empty, so
 * the screen has to be built the same way a cold start builds it.
 */
async function sessionEnded() {
  state.account = null;
  state.idempotencyKey = null;
  clearNotice();
  announce('Your session ended. Sign in again to continue.');
  await startSignIn();
  $('signin-heading').focus();
}

async function signOut() {
  // Guarded: if this throws, the fetch that actually ends the session never runs.
  try { window.google?.accounts?.id?.disableAutoSelect?.(); } catch { /* not loaded */ }
  await api('POST', '/auth/logout');
  state.account = null;
  state.idempotencyKey = null;
  clearNotice();
  location.reload();
}

/* --------------------------------------------------------------- sign in -- */

const loadGis = () =>
  new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.onload = resolve;
    script.onerror = () => reject(new Error('blocked'));
    document.head.append(script);
  });

/** The sign-in screen's only other state. `body` may carry `backticked` spans,
 *  which are set in mono like every other exact string in this product. */
function fallback(title, body) {
  $('gis').hidden = true;
  $('gis-fallback').hidden = false;
  $('gis-fallback-title').textContent = title;

  const target = $('gis-fallback-body');
  target.replaceChildren(
    ...body.split('`').map((part, i) => (i % 2 ? el('code', null, part) : document.createTextNode(part))),
  );
}

const prefersDark = window.matchMedia('(prefers-color-scheme: dark)');

/** Google's own button, configured to sit inside this page rather than on it.
 *  Re-rendered when the OS theme flips, because `outline` burns a hole in a
 *  #101214 ground and `filled_black` out-shouts everything on paper. */
function renderGoogleButton() {
  const frame = $('gis');
  frame.replaceChildren();
  const width = Math.max(200, Math.min(400, frame.clientWidth || 318));
  window.google.accounts.id.renderButton(frame, {
    type: 'standard',
    theme: prefersDark.matches ? 'filled_black' : 'outline',
    size: 'large',
    shape: 'rectangular',
    text: 'signin_with',
    logo_alignment: 'left',
    width,
  });
}

async function onCredential(response) {
  const res = await api('POST', '/auth/google', { credential: response.credential });

  if (res.ok) {
    await enter(res.body);
    return;
  }
  // The nonce is bound to a timestamp, so a page left open past its window can
  // only be fixed by getting a fresh one.
  if (res.code === 'NONCE_INVALID') {
    location.reload();
    return;
  }
  fallback('Sign-in was rejected', res.message || `The server answered ${res.status}.`);
}

async function startSignIn() {
  show('signin');

  const config = await api('GET', '/auth/config');
  if (!config.ok || !config.body.configured) {
    fallback(
      'Google sign-in is not configured',
      'Set `GOOGLE_CLIENT_ID` on the server to a Google OAuth web client id, then reload. The README has the console steps.',
    );
    return;
  }

  try {
    await loadGis();
  } catch {
    fallback(
      'Google could not be reached',
      'accounts.google.com did not load — usually a blocked script or an offline network. Sign-in needs it.',
    );
    return;
  }

  window.google.accounts.id.initialize({
    client_id: config.body.clientId,
    callback: onCredential,
    // Echoed back inside the ID token, where the server checks it. Without it a
    // token minted for another site could be replayed against this one.
    nonce: config.body.nonce,
    auto_select: false,
    cancel_on_tap_outside: true,
  });

  renderGoogleButton();
  prefersDark.addEventListener('change', renderGoogleButton);
}

/* ------------------------------------------------------------------ boot -- */

function wire() {
  $('form').addEventListener('submit', submit);
  $('signout').addEventListener('click', signOut);
  $('address').addEventListener('input', syncCounter);
  for (const radio of document.querySelectorAll('input[name="network"]')) {
    radio.addEventListener('change', syncNetwork);
  }
  // An error is the client's claim about what you typed; the moment you type
  // again it is out of date.
  for (const field of FIELDS) {
    const input = $(field);
    if (input) input.addEventListener('input', () => {
      const target = $(`err-${field}`);
      target.hidden = true;
      target.textContent = '';
      input.removeAttribute('aria-invalid');
      input.removeAttribute('aria-describedby');
    });
  }

  $('copy').addEventListener('click', async () => {
    if (!state.account) return;
    try {
      await navigator.clipboard.writeText(state.account.id);
      const button = $('copy');
      button.classList.add('is-done');
      announce('Account id copied');
      setTimeout(() => button.classList.remove('is-done'), 1400);
    } catch {
      announce('Could not copy the account id');
    }
  });

  syncNetwork();
}

async function boot() {
  wire();
  const me = await api('GET', '/me');
  if (me.ok) {
    await enter(me.body);
  } else {
    await startSignIn();
  }
}

// Nothing is rendered until boot() decides which view to show, so an unhandled
// rejection here is a blank page with no explanation anywhere.
boot().catch(() => {
  show('signin');
  fallback('The page could not start', 'The server did not answer. Check that it is running, then reload.');
});

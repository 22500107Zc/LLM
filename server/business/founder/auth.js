const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const { AuditLog } = require("../models/audit");
const provisioning = require("../services/provisioning");

/**
 * Founder authentication.
 *
 * The experience is deliberately one field: a password, then the console.
 * There is one operator, so an identity provider would be ceremony without
 * benefit. The implementation underneath is not casual:
 *
 *   - The password is never in this repository, a bundle, a seed or a log. It
 *     exists only as a bcrypt hash in FOUNDER_PASSWORD_HASH on the server.
 *   - Comparison is bcrypt's own constant-time check.
 *   - The session is a random opaque token held server-side, sent as an
 *     HttpOnly cookie. Nothing about it is derived from the password, so a
 *     stolen token cannot be turned back into one.
 *   - Failed attempts are rate limited per address, with a lockout.
 *   - The console refuses to switch on at all unless it has somewhere to act:
 *     a state directory. A customer's own deployment has none.
 */

const COOKIE_NAME = "founder_session";
const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // a working day
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;

/** Sessions live in memory: a restart signing everyone out is correct here. */
const sessions = new Map();
/** address -> { count, firstAt, lockedUntil } */
const attempts = new Map();

function enabled() {
  return (
    String(process.env.FOUNDER_CONSOLE_ENABLED ?? "").toLowerCase() === "true"
  );
}

function configuredHash() {
  return String(process.env.FOUNDER_PASSWORD_HASH ?? "").trim();
}

/**
 * Why the console is or is not available.
 *
 * Returned to an unauthenticated caller, so it says what is missing without
 * revealing anything: never the hash, never whether a password was close.
 */
function availability() {
  if (!enabled())
    return {
      available: false,
      reason: "The founder console is not enabled on this deployment.",
    };
  if (!configuredHash())
    return {
      available: false,
      reason:
        "The founder console is enabled but FOUNDER_PASSWORD_HASH is not set.",
    };
  if (!provisioning.stateDirAvailable())
    return {
      available: false,
      reason:
        "The founder console has no deployment state directory to manage. Set PLATFORM_STATE_DIR on the host that holds deployments/.",
    };
  return { available: true };
}

// ------------------------------------------------------------ rate limit ---

/**
 * The address a lockout is counted against.
 *
 * Deliberately NOT read from `X-Forwarded-For` directly. Anyone can set that
 * header, so keying on it would mean an attacker rotating a made-up value gets
 * unlimited guesses - the lockout would be decorative. Express already
 * resolves the correct client address in `request.ip` when the application is
 * configured to trust its proxy, and falls back to the socket when it is not,
 * which is the value that cannot be forged.
 */
function attemptKey(request) {
  return request.ip || request.socket?.remoteAddress || "unknown";
}

/**
 * Failed-attempt records are bounded.
 *
 * Without this, a source rotating addresses would grow the map without limit.
 * Expired records go first; if they are all live, the oldest go - which at
 * worst forgives the earliest attacker while the current one stays counted.
 */
const MAX_TRACKED_ADDRESSES = 10_000;

function pruneAttempts() {
  const now = Date.now();
  for (const [key, record] of attempts)
    if (
      (!record.lockedUntil || record.lockedUntil <= now) &&
      now - record.firstAt > ATTEMPT_WINDOW_MS
    )
      attempts.delete(key);

  if (attempts.size <= MAX_TRACKED_ADDRESSES) return;
  // Map iterates in insertion order, so this drops the oldest first.
  const excess = attempts.size - MAX_TRACKED_ADDRESSES;
  let removed = 0;
  for (const key of attempts.keys()) {
    if (removed >= excess) break;
    attempts.delete(key);
    removed += 1;
  }
}

function lockoutFor(key) {
  const record = attempts.get(key);
  if (!record) return 0;
  if (record.lockedUntil && record.lockedUntil > Date.now())
    return record.lockedUntil - Date.now();
  return 0;
}

function recordFailure(key) {
  const now = Date.now();
  const record = attempts.get(key) ?? { count: 0, firstAt: now };
  // A slow drip of guesses should not accumulate forever.
  if (now - record.firstAt > ATTEMPT_WINDOW_MS) {
    record.count = 0;
    record.firstAt = now;
  }
  record.count += 1;
  if (record.count >= MAX_ATTEMPTS) record.lockedUntil = now + LOCKOUT_MS;
  attempts.set(key, record);
  pruneAttempts();
  return record;
}

const clearFailures = (key) => attempts.delete(key);

// --------------------------------------------------------------- session ---

function createSession() {
  const token = crypto.randomBytes(32).toString("hex");
  const session = {
    token,
    createdAt: Date.now(),
    expiresAt: Date.now() + SESSION_TTL_MS,
    // A CSRF token for state-changing requests, since the session travels as
    // a cookie the browser attaches automatically.
    csrf: crypto.randomBytes(24).toString("hex"),
  };
  sessions.set(token, session);
  return session;
}

function readSession(token) {
  if (!token) return null;
  const session = sessions.get(String(token));
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    sessions.delete(session.token);
    return null;
  }
  return session;
}

function destroySession(token) {
  if (token) sessions.delete(String(token));
}

/** Removes anything already expired. Cheap and bounded. */
function pruneSessions() {
  const now = Date.now();
  for (const [token, session] of sessions)
    if (session.expiresAt <= now) sessions.delete(token);
}

function cookieOptions() {
  return {
    httpOnly: true,
    // The console is served from the same origin it calls, so Lax is enough
    // and keeps a normal top-level navigation working.
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_TTL_MS,
  };
}

// ------------------------------------------------------------------ auth ---

/**
 * Verifies the founder password.
 * @returns {Promise<{ok: boolean, session?: object, error?: string, retryAfterMs?: number}>}
 */
async function authenticate(request, password) {
  const state = availability();
  if (!state.available) return { ok: false, error: state.reason };

  const key = attemptKey(request);
  const locked = lockoutFor(key);
  if (locked > 0)
    return {
      ok: false,
      error: "Too many failed attempts. Try again later.",
      retryAfterMs: locked,
    };

  const supplied = String(password ?? "");
  // Always run the comparison, even for an empty value, so a missing password
  // and a wrong one take the same time.
  let matches = false;
  try {
    matches = await bcrypt.compare(supplied, configuredHash());
  } catch {
    matches = false;
  }

  if (!matches) {
    const record = recordFailure(key);
    await AuditLog.log({
      action: "founder.login_failed",
      category: AuditLog.CATEGORIES.SECURITY,
      resource: "founder_session",
      // Never the attempted password, never its length.
      metadata: { attempts: record.count, locked: !!record.lockedUntil },
    });
    return { ok: false, error: "Incorrect password." };
  }

  clearFailures(key);
  pruneSessions();
  const session = createSession();
  await AuditLog.log({
    action: "founder.login_succeeded",
    category: AuditLog.CATEGORIES.SECURITY,
    resource: "founder_session",
    metadata: { expiresAt: new Date(session.expiresAt).toISOString() },
  });
  return { ok: true, session };
}

/**
 * Reads the founder cookie.
 *
 * Express does not parse cookies here and this needs exactly one, so it is
 * read directly rather than adding a dependency. Only the named cookie is
 * looked at; everything else in the header is ignored.
 */
function cookieValue(request, name) {
  const header = request.headers?.cookie;
  if (!header) return null;
  for (const part of String(header).split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    if (part.slice(0, index).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

function sessionFrom(request) {
  // request.cookies exists if something upstream parsed them; otherwise read
  // the header directly.
  const fromCookie =
    request.cookies?.[COOKIE_NAME] ?? cookieValue(request, COOKIE_NAME);
  return readSession(fromCookie);
}

/**
 * Gate for every founder route.
 *
 * A normal customer session can never satisfy this: it looks only at the
 * founder cookie and the server-side session store, and knows nothing about
 * the customer JWT.
 */
function requireFounder(request, response, next) {
  const state = availability();
  if (!state.available)
    return response.status(404).json({ error: "Not found." });

  const session = sessionFrom(request);
  if (!session)
    return response
      .status(401)
      .json({ error: "Founder authentication required." });

  // A cookie the browser attaches on its own needs a second factor the
  // attacker's page cannot read.
  const mutating = !["GET", "HEAD", "OPTIONS"].includes(request.method);
  if (mutating) {
    const supplied = String(request.headers["x-founder-csrf"] ?? "");
    const expected = session.csrf;
    if (
      supplied.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))
    )
      return response.status(403).json({ error: "Invalid request token." });
  }

  response.locals.founderSession = session;
  next();
}

module.exports = {
  COOKIE_NAME,
  SESSION_TTL_MS,
  MAX_ATTEMPTS,
  enabled,
  availability,
  authenticate,
  requireFounder,
  sessionFrom,
  cookieValue,
  createSession,
  readSession,
  destroySession,
  pruneSessions,
  cookieOptions,
  // Exported so tests can reset between cases.
  _sessions: sessions,
  _attempts: attempts,
};

const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const { AuditLog } = require("../models/audit");

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
 *   - The console is off unless FOUNDER_CONSOLE_ENABLED and a hash are both
 *     set, and every founder route answers 404 when it is off.
 */

const COOKIE_NAME = "founder_session";
const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // a working day
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;

/**
 * Where a session actually lives.
 *
 * The database, so that every instance of a runtime that scales can see it.
 * These were in-memory Maps, and on Vercel that meant only the instance which
 * served the login knew the session: 14 of 20 concurrent founder requests on
 * one valid session came back 401. A lockout counted the same way let an
 * attacker have five guesses per warm instance rather than five in total.
 *
 * The Map survives as a fallback, and only that. A deployment with no
 * database yet still lets the founder sign in to the console that explains
 * what is missing - on one instance, which is all such a deployment has to
 * offer anyway.
 */
const sessions = new Map();
/** address -> { count, firstAt, lockedUntil } */
const attempts = new Map();

/** A session token is never stored as given; a copy of the table is useless. */
const fingerprint = (token) =>
  crypto.createHash("sha256").update(String(token)).digest("hex");

function db() {
  try {
    return require("../../utils/prisma");
  } catch {
    return null;
  }
}

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

async function lockoutFor(key) {
  const prisma = db();
  if (prisma) {
    try {
      const row = await prisma.business_founder_login_attempts.findUnique({
        where: { attempt_key: key },
      });
      if (row?.locked_until && row.locked_until.getTime() > Date.now())
        return row.locked_until.getTime() - Date.now();
      return 0;
    } catch (error) {
      console.error("[founder] could not read login attempts:", error.message);
    }
  }

  const record = attempts.get(key);
  if (!record) return 0;
  if (record.lockedUntil && record.lockedUntil > Date.now())
    return record.lockedUntil - Date.now();
  return 0;
}

async function recordFailure(key) {
  const now = Date.now();
  const prisma = db();

  if (prisma) {
    try {
      const existing = await prisma.business_founder_login_attempts.findUnique({
        where: { attempt_key: key },
      });

      // A slow drip of guesses should not accumulate forever.
      const stale =
        existing && now - existing.first_at.getTime() > ATTEMPT_WINDOW_MS;
      const count = stale ? 1 : (existing?.count ?? 0) + 1;
      const firstAt = stale || !existing ? new Date(now) : existing.first_at;
      const lockedUntil =
        count >= MAX_ATTEMPTS ? new Date(now + LOCKOUT_MS) : null;

      const row = await prisma.business_founder_login_attempts.upsert({
        where: { attempt_key: key },
        update: { count, first_at: firstAt, locked_until: lockedUntil },
        create: {
          attempt_key: key,
          count,
          first_at: firstAt,
          locked_until: lockedUntil,
        },
      });
      return { count: row.count, lockedUntil: row.locked_until?.getTime() };
    } catch (error) {
      console.error(
        "[founder] could not record a login attempt:",
        error.message
      );
    }
  }

  const record = attempts.get(key) ?? { count: 0, firstAt: now };
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

async function clearFailures(key) {
  attempts.delete(key);
  const prisma = db();
  if (!prisma) return;
  try {
    await prisma.business_founder_login_attempts.deleteMany({
      where: { attempt_key: key },
    });
  } catch (error) {
    console.error("[founder] could not clear login attempts:", error.message);
  }
}

// --------------------------------------------------------------- session ---

async function createSession() {
  const token = crypto.randomBytes(32).toString("hex");
  const session = {
    token,
    createdAt: Date.now(),
    expiresAt: Date.now() + SESSION_TTL_MS,
    // A CSRF token for state-changing requests, since the session travels as
    // a cookie the browser attaches automatically.
    csrf: crypto.randomBytes(24).toString("hex"),
  };

  // The instance that issued it can answer without a round trip; every other
  // instance reads the row.
  sessions.set(token, session);

  const prisma = db();
  if (prisma) {
    try {
      await prisma.business_founder_sessions.create({
        data: {
          token_hash: fingerprint(token),
          csrf: session.csrf,
          expires_at: new Date(session.expiresAt),
        },
      });
    } catch (error) {
      // A deployment with no database still gets a working console on this
      // one instance, which is the only thing it has.
      console.error(
        "[founder] session not shared across instances:",
        error.message
      );
    }
  }

  return session;
}

async function readSession(token) {
  if (!token) return null;
  const key = String(token);

  const local = sessions.get(key);
  if (local) {
    if (local.expiresAt > Date.now()) return local;
    sessions.delete(key);
  }

  const prisma = db();
  if (!prisma) return null;

  try {
    const row = await prisma.business_founder_sessions.findUnique({
      where: { token_hash: fingerprint(key) },
    });
    if (!row) return null;

    if (row.expires_at.getTime() <= Date.now()) {
      await prisma.business_founder_sessions.deleteMany({
        where: { id: row.id },
      });
      return null;
    }

    const session = {
      token: key,
      createdAt: row.createdAt.getTime(),
      expiresAt: row.expires_at.getTime(),
      csrf: row.csrf,
    };
    sessions.set(key, session);
    return session;
  } catch (error) {
    // Fail closed. An unreadable store is not a reason to let anyone in.
    console.error("[founder] could not read the session:", error.message);
    return null;
  }
}

async function destroySession(token) {
  if (!token) return;
  const key = String(token);
  sessions.delete(key);

  const prisma = db();
  if (!prisma) return;
  try {
    await prisma.business_founder_sessions.deleteMany({
      where: { token_hash: fingerprint(key) },
    });
  } catch (error) {
    console.error("[founder] could not end the session:", error.message);
  }
}

/** Removes anything already expired. Cheap and bounded. */
async function pruneSessions() {
  const now = Date.now();
  for (const [token, session] of sessions)
    if (session.expiresAt <= now) sessions.delete(token);

  const prisma = db();
  if (!prisma) return;
  try {
    await prisma.business_founder_sessions.deleteMany({
      where: { expires_at: { lte: new Date(now) } },
    });
  } catch (error) {
    console.error("[founder] could not prune sessions:", error.message);
  }
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
  const locked = await lockoutFor(key);
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
    const record = await recordFailure(key);
    await AuditLog.log({
      action: "founder.login_failed",
      category: AuditLog.CATEGORIES.SECURITY,
      resource: "founder_session",
      // Never the attempted password, never its length.
      metadata: { attempts: record.count, locked: !!record.lockedUntil },
    });
    return { ok: false, error: "Incorrect password." };
  }

  await clearFailures(key);
  await pruneSessions();
  const session = await createSession();
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

async function sessionFrom(request) {
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
async function requireFounder(request, response, next) {
  try {
    return await gate(request, response, next);
  } catch (error) {
    // Reading the session is now a database call. If it throws, refuse -
    // never fall through to the route.
    console.error("[founder] authentication failed:", error.message);
    return response
      .status(401)
      .json({ error: "Founder authentication required." });
  }
}

async function gate(request, response, next) {
  const state = availability();
  if (!state.available)
    return response.status(404).json({ error: "Not found." });

  const session = await sessionFrom(request);
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
  /**
   * Clears every trace of sessions and lockouts, in memory AND in the
   * database. A suite that only cleared the Maps would leave a real lockout
   * row behind and then fail the next fifty tests for the wrong reason.
   */
  _reset: async function () {
    sessions.clear();
    attempts.clear();
    const prisma = db();
    if (!prisma) return;
    try {
      await prisma.business_founder_sessions.deleteMany({});
      await prisma.business_founder_login_attempts.deleteMany({});
    } catch {
      /* the tables may not exist yet; nothing to clear */
    }
  },
  _sessions: sessions,
  _attempts: attempts,
};

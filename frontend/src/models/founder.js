import { API_BASE } from "@/utils/constants";

/**
 * Client for the founder control plane (/api/founder/*).
 *
 * Deliberately NOT built on `baseHeaders()`. The customer API authenticates
 * with a JWT this application keeps in browser storage; the founder plane
 * authenticates with an HttpOnly cookie the browser holds and this code cannot
 * read. Mixing the two would mean a customer token travelling to founder
 * routes, and a founder credential sitting where a script could read it.
 *
 * The only thing held in memory here is the CSRF token, which is useless on
 * its own - it does nothing without the cookie, which no script can reach.
 */

const FOUNDER_BASE = `${API_BASE}/founder`;
const GENERIC_ERROR = "Something went wrong. Please try again.";

/** In memory only. Cleared on sign-out and gone on refresh, where the session
 * endpoint hands back a fresh one if the cookie is still valid. */
let csrfToken = null;

export function setCsrfToken(value) {
  csrfToken = value ?? null;
}

async function request(path, { method = "GET", body = null } = {}) {
  try {
    const response = await fetch(`${FOUNDER_BASE}${path}`, {
      method,
      // The session cookie is the credential; it must be sent.
      credentials: "same-origin",
      headers: {
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...(method !== "GET" && csrfToken
          ? { "x-founder-csrf": csrfToken }
          : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    return { status: response.status, ok: response.ok, payload };
  } catch {
    return {
      status: 0,
      ok: false,
      payload: { error: "Could not reach the server." },
    };
  }
}

/** Every mutation answers the same shape so the console can stay simple. */
function outcome({ ok, payload }) {
  return ok
    ? { success: true, customer: payload?.customer ?? null }
    : { success: false, error: payload?.error ?? GENERIC_ERROR };
}

const Founder = {
  GENERIC_ERROR,

  /** Whether the console exists here, and whether this browser is signed in. */
  session: async function () {
    const { payload } = await request("/session");
    if (payload?.csrfToken) setCsrfToken(payload.csrfToken);
    return (
      payload ?? {
        available: false,
        authenticated: false,
        reason: GENERIC_ERROR,
      }
    );
  },

  signIn: async function (password) {
    const { ok, payload } = await request("/login", {
      method: "POST",
      body: { password },
    });
    if (ok && payload?.csrfToken) setCsrfToken(payload.csrfToken);
    return ok
      ? { success: true }
      : { success: false, error: payload?.error ?? GENERIC_ERROR };
  },

  signOut: async function () {
    await request("/logout", { method: "POST" });
    setCsrfToken(null);
  },

  // ------------------------------------------------------------ customers --
  customers: async function () {
    const { ok, payload } = await request("/customers");
    return ok
      ? payload
      : { customers: [], counts: {}, error: payload?.error ?? GENERIC_ERROR };
  },

  customer: async function (id) {
    const { ok, payload } = await request(
      `/customers/${encodeURIComponent(id)}`
    );
    return ok ? payload.customer : null;
  },

  createCustomer: async function (input) {
    return outcome(
      await request("/customers", { method: "POST", body: input })
    );
  },

  updateCustomer: async function (id, input) {
    return outcome(
      await request(`/customers/${encodeURIComponent(id)}`, {
        method: "PUT",
        body: input,
      })
    );
  },

  changeEmail: async function (id, email) {
    return outcome(
      await request(`/customers/${encodeURIComponent(id)}/email`, {
        method: "POST",
        body: { email },
      })
    );
  },

  resetPassword: async function (id, password) {
    return outcome(
      await request(`/customers/${encodeURIComponent(id)}/password`, {
        method: "POST",
        body: { password },
      })
    );
  },

  setAccess: async function (id, access) {
    return outcome(
      await request(`/customers/${encodeURIComponent(id)}/access`, {
        method: "POST",
        body: { access },
      })
    );
  },

  removeCustomer: async function (id, confirmBusinessName) {
    const { ok, payload } = await request(
      `/customers/${encodeURIComponent(id)}`,
      { method: "DELETE", body: { confirmBusinessName } }
    );
    return ok
      ? { success: true }
      : { success: false, error: payload?.error ?? GENERIC_ERROR };
  },

  /** Is the platform ready to sell? Founder only. Says nothing about any
   * customer's AI service - that is theirs to connect, not ours to supply. */
  status: async function () {
    const { ok, payload } = await request("/readiness");
    return ok ? payload : null;
  },

  audit: async function () {
    const { payload } = await request("/audit");
    return payload?.entries ?? [];
  },
};

export default Founder;

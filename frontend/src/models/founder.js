import { API_BASE } from "@/utils/constants";

/**
 * Client for the founder control plane (/api/founder/*).
 *
 * Deliberately NOT built on `baseHeaders()`. The customer API authenticates
 * with a JWT this application keeps in localStorage; the founder plane
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

  deployments: async function () {
    const { ok, payload } = await request("/deployments");
    return ok
      ? payload
      : { deployments: [], error: payload?.error ?? GENERIC_ERROR };
  },

  deployment: async function (slug) {
    const { ok, payload } = await request(
      `/deployments/${encodeURIComponent(slug)}`
    );
    return ok ? payload : { error: payload?.error ?? GENERIC_ERROR };
  },

  provision: async function (input) {
    const { ok, payload } = await request("/deployments", {
      method: "POST",
      body: input,
    });
    return ok
      ? payload
      : {
          success: false,
          problems: payload?.problems ?? [payload?.error ?? GENERIC_ERROR],
        };
  },

  paymentLink: async function (slug, email = "") {
    const query = email ? `?email=${encodeURIComponent(email)}` : "";
    const { payload } = await request(
      `/deployments/${encodeURIComponent(slug)}/payment-link${query}`
    );
    return payload ?? { success: false, error: GENERIC_ERROR };
  },

  savePaymentLink: async function (slug, paymentLink) {
    const { ok, payload } = await request(
      `/deployments/${encodeURIComponent(slug)}/payment-link`,
      { method: "POST", body: { paymentLink } }
    );
    return ok
      ? payload
      : { success: false, error: payload?.error ?? GENERIC_ERROR };
  },

  events: async function (slug) {
    const { payload } = await request(
      `/deployments/${encodeURIComponent(slug)}/events`
    );
    return payload ?? { reachable: false, reason: GENERIC_ERROR };
  },

  audit: async function () {
    const { payload } = await request("/audit");
    return payload?.entries ?? [];
  },
};

export default Founder;

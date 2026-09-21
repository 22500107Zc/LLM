import { API_BASE } from "@/utils/constants";
import { baseHeaders } from "@/utils/request";

/**
 * Client for the commercial business API (/api/business/*).
 *
 * Every call funnels through `request` so error handling, auth headers and the
 * "professional error message" contract are applied uniformly - a raw server
 * error is never surfaced to a business user.
 */

const BUSINESS_BASE = `${API_BASE}/business`;

const GENERIC_ERROR = "Something went wrong. Please try again.";

async function request(
  path,
  { method = "GET", body = null, raw = false } = {}
) {
  try {
    const response = await fetch(`${BUSINESS_BASE}${path}`, {
      method,
      headers: {
        ...baseHeaders(),
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

    if (raw) return response;

    if (response.status === 401)
      return { error: "Your session has expired. Please sign in again." };
    if (response.status === 403)
      return { error: "You do not have permission to do that." };
    if (response.status === 402) {
      const payload = await response.json().catch(() => ({}));
      return {
        error: payload.message ?? "AI usage is currently suspended.",
        billing: payload.billing,
      };
    }

    const payload = await response.json().catch(() => null);
    if (!response.ok)
      return { error: payload?.error ?? payload?.message ?? GENERIC_ERROR };
    return payload ?? {};
  } catch {
    return { error: "Could not reach the server. Check your connection." };
  }
}

/** Triggers a browser download for a CSV export endpoint. */
async function download(path, filename) {
  const response = await request(path, { raw: true });
  if (!response?.ok) return false;
  const blob = await response.blob();
  const url = window.URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.URL.revokeObjectURL(url);
  return true;
}

const Business = {
  // --- identity -----------------------------------------------------------
  me: () => request("/me"),
  dashboard: () => request("/dashboard"),
  billingState: () => request("/billing-state"),

  // --- billing ------------------------------------------------------------
  billing: {
    summary: () => request("/billing/summary"),
    configuration: () => request("/billing/configuration"),
    verifyPrice: () => request("/billing/verify-price"),
    invoices: () => request("/billing/invoices"),
    checkout: (body) => request("/billing/checkout", { method: "POST", body }),
    invoiceSubscription: (body) =>
      request("/billing/invoice-subscription", { method: "POST", body }),
    portal: () => request("/billing/portal", { method: "POST", body: {} }),
    sync: () => request("/billing/sync", { method: "POST", body: {} }),
    cancel: (immediately = false) =>
      request("/billing/cancel", { method: "POST", body: { immediately } }),
    resume: () => request("/billing/resume", { method: "POST", body: {} }),
    associate: (body) =>
      request("/billing/associate", { method: "POST", body }),
  },

  // --- agents -------------------------------------------------------------
  agents: {
    all: () => request("/agents"),
    templates: () => request("/agents/templates"),
    get: (uuid) => request(`/agents/${uuid}`),
    create: (body) => request("/agents", { method: "POST", body }),
    update: (uuid, body) =>
      request(`/agents/${uuid}`, { method: "POST", body }),
    delete: (uuid) => request(`/agents/${uuid}`, { method: "DELETE" }),
  },

  // --- website agents (embeds) --------------------------------------------
  websiteAgents: {
    all: () => request("/website-agents"),
    create: (body) => request("/website-agents", { method: "POST", body }),
    update: (uuid, body) =>
      request(`/website-agents/${uuid}`, { method: "POST", body }),
    delete: (uuid) => request(`/website-agents/${uuid}`, { method: "DELETE" }),
    snippet: (uuid) => request(`/website-agents/${uuid}/snippet`),
  },

  // --- knowledge ----------------------------------------------------------
  knowledge: {
    all: (agentUuid = null) =>
      request(
        `/knowledge${agentUuid ? `?agentUuid=${encodeURIComponent(agentUuid)}` : ""}`
      ),
    available: () => request("/knowledge/available"),
    assign: (body) => request("/knowledge/assign", { method: "POST", body }),
    reingest: (docId) =>
      request(`/knowledge/${encodeURIComponent(docId)}/reingest`, {
        method: "POST",
        body: {},
      }),
  },

  // --- leads & escalations -------------------------------------------------
  leads: {
    all: (params = {}) => request(`/leads?${new URLSearchParams(params)}`),
    setStatus: (uuid, status) =>
      request(`/leads/${uuid}/status`, { method: "POST", body: { status } }),
    addNote: (uuid, note) =>
      request(`/leads/${uuid}/notes`, { method: "POST", body: { note } }),
    redeliver: (uuid) =>
      request(`/leads/${uuid}/redeliver`, { method: "POST", body: {} }),
    exportCsv: (status = null) =>
      download(
        `/leads/export${status ? `?status=${encodeURIComponent(status)}` : ""}`,
        `leads-${new Date().toISOString().slice(0, 10)}.csv`
      ),
  },

  escalations: {
    all: (params = {}) =>
      request(`/escalations?${new URLSearchParams(params)}`),
    setStatus: (uuid, status) =>
      request(`/escalations/${uuid}/status`, {
        method: "POST",
        body: { status },
      }),
    redeliver: (uuid) =>
      request(`/escalations/${uuid}/redeliver`, { method: "POST", body: {} }),
    create: (body) => request("/escalations", { method: "POST", body }),
  },

  // --- conversations -------------------------------------------------------
  conversations: {
    all: (params = {}) =>
      request(`/conversations?${new URLSearchParams(params)}`),
    transcript: (channel, referenceId) =>
      request(`/conversations/${channel}/${encodeURIComponent(referenceId)}`),
    review: (channel, referenceId, body) =>
      request(
        `/conversations/${channel}/${encodeURIComponent(referenceId)}/review`,
        {
          method: "POST",
          body,
        }
      ),
    exportCsv: (params = {}) =>
      download(
        `/conversations/export?${new URLSearchParams(params)}`,
        `conversations-${new Date().toISOString().slice(0, 10)}.csv`
      ),
  },

  // --- analytics & insight -------------------------------------------------
  analytics: (days = 30) => request(`/analytics?days=${days}`),

  knowledgeGaps: {
    all: (params = {}) =>
      request(`/knowledge-gaps?${new URLSearchParams(params)}`),
    update: (id, body) =>
      request(`/knowledge-gaps/${id}`, { method: "POST", body }),
  },

  quality: {
    tests: () => request("/quality/tests"),
    createTest: (body) => request("/quality/tests", { method: "POST", body }),
    updateTest: (uuid, body) =>
      request(`/quality/tests/${uuid}`, { method: "POST", body }),
    deleteTest: (uuid) =>
      request(`/quality/tests/${uuid}`, { method: "DELETE" }),
    run: (testUuids = null) =>
      request("/quality/run", { method: "POST", body: { testUuids } }),
    runs: () => request("/quality/runs"),
    runResults: (uuid) => request(`/quality/runs/${uuid}`),
  },

  // --- team & keys ---------------------------------------------------------
  team: {
    all: () => request("/team"),
    createUser: (body) => request("/team/users", { method: "POST", body }),
    setRole: (id, body) =>
      request(`/team/users/${id}/role`, { method: "POST", body }),
    suspend: (id, suspended) =>
      request(`/team/users/${id}/suspend`, {
        method: "POST",
        body: { suspended },
      }),
    remove: (id) => request(`/team/users/${id}`, { method: "DELETE" }),
  },

  apiKeys: {
    all: () => request("/api-keys"),
    create: (name) => request("/api-keys", { method: "POST", body: { name } }),
    revoke: (id) => request(`/api-keys/${id}`, { method: "DELETE" }),
  },

  // --- integrations --------------------------------------------------------
  integrations: {
    all: () => request("/integrations"),
    create: (body) => request("/integrations", { method: "POST", body }),
    update: (uuid, body) =>
      request(`/integrations/${uuid}`, { method: "POST", body }),
    delete: (uuid) => request(`/integrations/${uuid}`, { method: "DELETE" }),
    test: (uuid) =>
      request(`/integrations/${uuid}/test`, { method: "POST", body: {} }),
    deliveries: (uuid) => request(`/integrations/${uuid}/deliveries`),
  },

  // --- value evidence ------------------------------------------------------
  value: {
    summary: (period) =>
      request(`/value/summary?period=${encodeURIComponent(period)}`),
    records: (params = {}) =>
      request(`/value/records?${new URLSearchParams(params)}`),
    history: (uuid) => request(`/value/records/${uuid}/history`),
    scenarios: (params = {}) =>
      request(`/value/scenarios?${new URLSearchParams(params)}`),
    create: (body) => request("/value/records", { method: "POST", body }),
    setVerification: (uuid, verification, note = null) =>
      request(`/value/records/${uuid}/verification`, {
        method: "POST",
        body: { verification, note },
      }),
    remove: (uuid) => request(`/value/records/${uuid}`, { method: "DELETE" }),
    exportCsv: (period) =>
      download(
        `/value/export?period=${encodeURIComponent(period)}`,
        `value-${period}.csv`
      ),
  },

  // --- platform ------------------------------------------------------------
  settings: {
    get: () => request("/settings"),
    saveCompany: (body) =>
      request("/settings/company", { method: "POST", body }),
  },

  onboarding: {
    get: () => request("/onboarding"),
    markStep: (step, complete = true) =>
      request(`/onboarding/${step}`, { method: "POST", body: { complete } }),
  },

  audit: (params = {}) => request(`/audit?${new URLSearchParams(params)}`),
  health: () => request("/health"),
};

export default Business;

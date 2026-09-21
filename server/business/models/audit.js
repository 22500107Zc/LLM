const prisma = require("../../utils/prisma");

/**
 * Keys that must never be persisted into the audit trail, at any nesting level.
 * Matching is done on a normalized (lowercased, punctuation-stripped) key name
 * so `apiKey`, `api_key` and `API-KEY` are all caught.
 *
 * Substring patterns are only used where they cannot collide with ordinary
 * business data. Short, ambiguous tokens are matched exactly instead - "pan"
 * as a substring would redact "company", and "auth" would redact "author".
 */
const REDACTED_SUBSTRINGS = [
  "password",
  "passwd",
  "secret",
  "token",
  "apikey",
  "authorization",
  "credential",
  "privatekey",
  "accesskey",
  "sessionid",
  "cookie",
  "card",
  "bearer",
  "signature",
];

const REDACTED_EXACT = new Set([
  "auth",
  "pan",
  "cvc",
  "cvv",
  "pin",
  "iban",
  "ssn",
]);

const MAX_METADATA_BYTES = 8_000;
const MAX_STRING_LENGTH = 512;

function normalizeKey(key) {
  return String(key).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isRedactedKey(key) {
  const normalized = normalizeKey(key);
  if (REDACTED_EXACT.has(normalized)) return true;
  return REDACTED_SUBSTRINGS.some((pattern) => normalized.includes(pattern));
}

/**
 * Recursively strips credential-shaped values and truncates long strings so an
 * audit record can never become an exfiltration path for secrets or document
 * contents.
 */
function sanitize(value, depth = 0) {
  if (depth > 5) return "[truncated]";
  if (value === null || value === undefined) return null;

  if (Array.isArray(value))
    return value.slice(0, 50).map((entry) => sanitize(entry, depth + 1));

  if (value instanceof Date) return value.toISOString();

  if (typeof value === "object") {
    const output = {};
    for (const [key, entry] of Object.entries(value)) {
      if (isRedactedKey(key)) {
        output[key] = "[redacted]";
        continue;
      }
      output[key] = sanitize(entry, depth + 1);
    }
    return output;
  }

  if (typeof value === "string") {
    return value.length > MAX_STRING_LENGTH
      ? `${value.slice(0, MAX_STRING_LENGTH)}…[truncated]`
      : value;
  }

  if (typeof value === "number" || typeof value === "boolean") return value;
  return String(value).slice(0, MAX_STRING_LENGTH);
}

const AuditLog = {
  CATEGORIES: Object.freeze({
    AUTH: "auth",
    USERS: "users",
    KNOWLEDGE: "knowledge",
    AGENTS: "agents",
    INTEGRATIONS: "integrations",
    BILLING: "billing",
    API_KEYS: "api_keys",
    AUTOMATIONS: "automations",
    EMBEDS: "embeds",
    LEADS: "leads",
    SETTINGS: "settings",
    SECURITY: "security",
    GENERAL: "general",
  }),

  /**
   * Records an auditable action. Never throws - auditing must not be able to
   * break the action it is recording.
   * @param {{action: string, category?: string, actor?: object|null, resource?: string|null, resourceId?: string|number|null, metadata?: object, ip?: string|null}} params
   */
  log: async function ({
    action,
    category = "general",
    actor = null,
    resource = null,
    resourceId = null,
    metadata = {},
    ip = null,
  } = {}) {
    try {
      if (!action) return null;
      let serialized = null;
      if (metadata && Object.keys(metadata).length) {
        serialized = JSON.stringify(sanitize(metadata));
        if (serialized.length > MAX_METADATA_BYTES)
          serialized = JSON.stringify({
            note: "metadata omitted - exceeded size limit",
            keys: Object.keys(metadata).slice(0, 25),
          });
      }

      return await prisma.audit_logs.create({
        data: {
          action: String(action).slice(0, 120),
          category: String(category).slice(0, 60),
          actor_id: actor?.id ? Number(actor.id) : null,
          actor_label: actor?.username
            ? String(actor.username).slice(0, 120)
            : actor?.label
              ? String(actor.label).slice(0, 120)
              : null,
          resource: resource ? String(resource).slice(0, 120) : null,
          resource_id: resourceId !== null && resourceId !== undefined
            ? String(resourceId).slice(0, 120)
            : null,
          metadata: serialized,
          ip_address: ip ? String(ip).slice(0, 64) : null,
        },
      });
    } catch (error) {
      console.error(`[AuditLog] failed to record "${action}":`, error.message);
      return null;
    }
  },

  /** Convenience wrapper that pulls the actor and IP off an express request. */
  fromRequest: async function (request, response, params = {}) {
    return this.log({
      ...params,
      actor: params.actor ?? response?.locals?.user ?? null,
      ip: params.ip ?? request?.ip ?? null,
    });
  },

  where: async function (clause = {}, limit = 100, offset = 0) {
    try {
      return await prisma.audit_logs.findMany({
        where: clause,
        take: Math.min(Number(limit) || 100, 500),
        skip: Number(offset) || 0,
        orderBy: { occurredAt: "desc" },
      });
    } catch (error) {
      console.error(error.message);
      return [];
    }
  },

  count: async function (clause = {}) {
    try {
      return await prisma.audit_logs.count({ where: clause });
    } catch (error) {
      console.error(error.message);
      return 0;
    }
  },

  // Exported for unit tests.
  _sanitize: sanitize,
  _isRedactedKey: isRedactedKey,
};

module.exports = { AuditLog };

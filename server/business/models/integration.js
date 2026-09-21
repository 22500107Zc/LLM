const { v4: uuidv4 } = require("uuid");
const prisma = require("../../utils/prisma");
const { AuditLog } = require("./audit");
const { EncryptionManager } = require("../../utils/EncryptionManager");

/**
 * Outbound business-system integrations.
 *
 * The architecture is one dispatcher plus a small provider descriptor, so
 * adding a CRM later is a new descriptor rather than a new subsystem. Secrets
 * (webhook signing keys, CRM tokens) are encrypted at rest with the same
 * persistent key manager upstream already uses, and are never returned to the
 * browser.
 */

const PROVIDERS = Object.freeze({
  WEBHOOK: "webhook",
  EMAIL: "email",
  SLACK: "slack",
  HUBSPOT: "hubspot",
  SALESFORCE: "salesforce",
});

/** Business events an integration can subscribe to. */
const EVENTS = Object.freeze([
  "lead.created",
  "escalation.created",
  "conversation.flagged",
  "knowledge_gap.detected",
  "quality_run.completed",
  "billing.status_changed",
]);

const PROVIDER_SPEC = Object.freeze({
  [PROVIDERS.WEBHOOK]: {
    label: "Generic Webhook",
    description:
      "POSTs a signed JSON payload to any HTTPS endpoint you control. Works with Zapier, Make, n8n or your own service.",
    configFields: [
      { key: "url", label: "Endpoint URL", type: "url", required: true },
    ],
    secretFields: [
      {
        key: "signingSecret",
        label: "Signing secret (optional)",
        help: "When set, deliveries carry an HMAC-SHA256 signature you can verify.",
      },
    ],
    implemented: true,
  },
  [PROVIDERS.EMAIL]: {
    label: "Email",
    description:
      "Sends a notification email. Requires SMTP to be configured on the deployment.",
    configFields: [
      { key: "to", label: "Recipient address", type: "email", required: true },
      { key: "subjectPrefix", label: "Subject prefix", type: "text", required: false },
    ],
    secretFields: [],
    implemented: true,
  },
  [PROVIDERS.SLACK]: {
    label: "Slack",
    description: "Posts a message to a Slack incoming webhook URL.",
    configFields: [],
    secretFields: [
      {
        key: "webhookUrl",
        label: "Slack incoming webhook URL",
        required: true,
        help: "Treated as a secret - it grants posting rights to your channel.",
      },
    ],
    implemented: true,
  },
  [PROVIDERS.HUBSPOT]: {
    label: "HubSpot",
    description:
      "Creates or updates a HubSpot contact when a lead is captured, using a private app token.",
    configFields: [],
    secretFields: [
      { key: "accessToken", label: "Private app access token", required: true },
    ],
    implemented: true,
  },
  [PROVIDERS.SALESFORCE]: {
    label: "Salesforce",
    description:
      "Delivers leads to a Salesforce Web-to-Lead endpoint. Full API integration is available as a documented extension.",
    configFields: [
      { key: "oid", label: "Organization ID (OID)", type: "text", required: true },
      {
        key: "endpoint",
        label: "Web-to-Lead endpoint",
        type: "url",
        required: false,
        help: "Defaults to the standard Salesforce Web-to-Lead URL.",
      },
    ],
    secretFields: [],
    implemented: true,
  },
});

let encryptionManager = null;
function encryptor() {
  if (!encryptionManager) encryptionManager = new EncryptionManager();
  return encryptionManager;
}

function safeJSON(value, fallback = {}) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

const Integration = {
  PROVIDERS,
  EVENTS,
  PROVIDER_SPEC,

  /** The provider catalogue shown in the Integrations UI. */
  catalogue() {
    return Object.entries(PROVIDER_SPEC).map(([provider, spec]) => ({
      provider,
      ...spec,
    }));
  },

  isValidProvider(provider) {
    return Object.values(PROVIDERS).includes(String(provider));
  },

  create: async function ({
    name,
    provider,
    config = {},
    secrets = {},
    events = [],
    enabled = true,
    actor = null,
  }) {
    if (!this.isValidProvider(provider))
      return { integration: null, error: "Unknown integration provider." };

    const spec = PROVIDER_SPEC[provider];
    for (const field of spec.configFields.filter((f) => f.required)) {
      if (!config?.[field.key])
        return { integration: null, error: `${field.label} is required.` };
    }
    for (const field of spec.secretFields.filter((f) => f.required)) {
      if (!secrets?.[field.key])
        return { integration: null, error: `${field.label} is required.` };
    }

    const selectedEvents = (Array.isArray(events) ? events : []).filter((e) =>
      EVENTS.includes(e)
    );

    try {
      const integration = await prisma.integrations.create({
        data: {
          uuid: uuidv4(),
          name: String(name || spec.label).slice(0, 160),
          provider: String(provider),
          enabled: Boolean(enabled),
          config: JSON.stringify(config ?? {}),
          secret_ciphered: Object.keys(secrets ?? {}).length
            ? encryptor().encrypt(JSON.stringify(secrets))
            : null,
          events: JSON.stringify(
            selectedEvents.length ? selectedEvents : ["lead.created", "escalation.created"]
          ),
          createdBy: actor?.id ? Number(actor.id) : null,
        },
      });

      await AuditLog.log({
        action: "integration.created",
        category: AuditLog.CATEGORIES.INTEGRATIONS,
        actor,
        resource: "integration",
        resourceId: integration.uuid,
        // `secrets` is intentionally never passed into the audit metadata.
        metadata: { provider, name: integration.name, events: selectedEvents },
      });

      return { integration: this.toPublic(integration), error: null };
    } catch (error) {
      console.error("[Integration] create failed:", error.message);
      return { integration: null, error: "Unable to create the integration." };
    }
  },

  update: async function ({ uuid, patch = {}, secrets = null, actor = null }) {
    try {
      const existing = await prisma.integrations.findUnique({
        where: { uuid: String(uuid) },
      });
      if (!existing) return { success: false, error: "Integration not found." };

      const data = { lastUpdatedAt: new Date() };
      if (patch.name !== undefined) data.name = String(patch.name).slice(0, 160);
      if (patch.enabled !== undefined) data.enabled = Boolean(patch.enabled);
      if (patch.config !== undefined) data.config = JSON.stringify(patch.config ?? {});
      if (patch.events !== undefined)
        data.events = JSON.stringify(
          (Array.isArray(patch.events) ? patch.events : []).filter((e) =>
            EVENTS.includes(e)
          )
        );
      // Secrets are only rewritten when new values are supplied, so a UI that
      // never receives them cannot accidentally blank them out.
      if (secrets && Object.keys(secrets).length) {
        const current = this.secretsFor(existing);
        data.secret_ciphered = encryptor().encrypt(
          JSON.stringify({ ...current, ...secrets })
        );
      }

      const integration = await prisma.integrations.update({
        where: { uuid: String(uuid) },
        data,
      });

      await AuditLog.log({
        action: "integration.updated",
        category: AuditLog.CATEGORIES.INTEGRATIONS,
        actor,
        resource: "integration",
        resourceId: uuid,
        metadata: {
          provider: existing.provider,
          enabled: integration.enabled,
          secretsRotated: Boolean(secrets && Object.keys(secrets).length),
        },
      });

      return { success: true, integration: this.toPublic(integration) };
    } catch (error) {
      console.error("[Integration] update failed:", error.message);
      return { success: false, error: "Unable to update the integration." };
    }
  },

  delete: async function ({ uuid, actor = null }) {
    try {
      const existing = await prisma.integrations.findUnique({
        where: { uuid: String(uuid) },
      });
      if (!existing) return { success: false, error: "Integration not found." };

      await prisma.integration_deliveries.deleteMany({
        where: { integration_id: existing.id },
      });
      await prisma.integrations.delete({ where: { uuid: String(uuid) } });

      await AuditLog.log({
        action: "integration.removed",
        category: AuditLog.CATEGORIES.INTEGRATIONS,
        actor,
        resource: "integration",
        resourceId: uuid,
        metadata: { provider: existing.provider, name: existing.name },
      });
      return { success: true };
    } catch (error) {
      console.error("[Integration] delete failed:", error.message);
      return { success: false, error: "Unable to remove the integration." };
    }
  },

  get: async function (clause = {}) {
    try {
      return await prisma.integrations.findFirst({ where: clause });
    } catch (error) {
      console.error(error.message);
      return null;
    }
  },

  where: async function (clause = {}) {
    try {
      return await prisma.integrations.findMany({
        where: clause,
        orderBy: { id: "asc" },
      });
    } catch (error) {
      console.error(error.message);
      return [];
    }
  },

  /** Decrypts an integration's secrets. Server-side use only. */
  secretsFor(integration) {
    if (!integration?.secret_ciphered) return {};
    try {
      return safeJSON(encryptor().decrypt(integration.secret_ciphered), {});
    } catch (error) {
      console.error("[Integration] secret decryption failed:", error.message);
      return {};
    }
  },

  /**
   * The browser-safe shape. Secrets are reduced to a boolean so the UI can show
   * "configured" without ever receiving the value.
   */
  toPublic(integration) {
    if (!integration) return null;
    const secrets = this.secretsFor(integration);
    return {
      uuid: integration.uuid,
      name: integration.name,
      provider: integration.provider,
      enabled: integration.enabled,
      config: safeJSON(integration.config, {}),
      configuredSecrets: Object.keys(secrets),
      events: safeJSON(integration.events, []),
      lastStatus: integration.last_status,
      lastError: integration.last_error,
      lastDelivery: integration.last_delivery,
      createdAt: integration.createdAt,
    };
  },

  recordDelivery: async function ({
    integrationId,
    event,
    status,
    statusCode = null,
    error = null,
  }) {
    try {
      await prisma.integration_deliveries.create({
        data: {
          integration_id: Number(integrationId),
          event: String(event).slice(0, 120),
          status: String(status).slice(0, 40),
          status_code: statusCode ?? null,
          error: error ? String(error).slice(0, 500) : null,
        },
      });
      await prisma.integrations.update({
        where: { id: Number(integrationId) },
        data: {
          last_status: String(status).slice(0, 40),
          last_error: error ? String(error).slice(0, 500) : null,
          last_delivery: new Date(),
        },
      });
    } catch (e) {
      console.error("[Integration] delivery log failed:", e.message);
    }
  },

  deliveries: async function (integrationId, limit = 25) {
    try {
      return await prisma.integration_deliveries.findMany({
        where: { integration_id: Number(integrationId) },
        take: Math.min(Number(limit) || 25, 100),
        orderBy: { attemptedAt: "desc" },
      });
    } catch (error) {
      console.error(error.message);
      return [];
    }
  },
};

module.exports = { Integration, PROVIDERS, EVENTS };

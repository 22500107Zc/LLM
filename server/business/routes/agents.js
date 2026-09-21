const { reqBody } = require("../../utils/http");
const { AgentProfile } = require("../models/agentProfile");
const { Lead } = require("../models/lead");
const { AuditLog } = require("../models/audit");
const { requireCapability, safeHandler } = require("../middleware");
const config = require("../config");

/**
 * AI Agent management - the business-facing layer over upstream workspaces.
 */
function agentRoutes(router) {
  router.get(
    "/agents",
    [requireCapability("agents:view")],
    safeHandler(async (_request, response) => {
      const agents = await AgentProfile.where({});
      const hydrated = await Promise.all(
        agents.map((a) => AgentProfile.hydrate(a))
      );
      const slots = await AgentProfile.publicAgentSlotAvailable();
      response.status(200).json({
        agents: hydrated,
        limits: {
          maxPublicAgents: config.limits.maxPublicAgents,
          publicAgentsUsed: hydrated.filter((a) => a.visibility === "public")
            .length,
          publicSlotAvailable: slots.available,
        },
      });
    })
  );

  router.get(
    "/agents/templates",
    [requireCapability("agents:view")],
    safeHandler(async (_request, response) => {
      response.status(200).json({
        templates: AgentProfile.templateCatalogue(),
        leadCaptureFields: Lead.CONFIGURABLE_FIELDS,
        defaultFallback: AgentProfile.DEFAULT_FALLBACK,
      });
    })
  );

  router.get(
    "/agents/:uuid",
    [requireCapability("agents:view")],
    safeHandler(async (request, response) => {
      const agent = await AgentProfile.get({
        uuid: String(request.params.uuid),
      });
      if (!agent)
        return response.status(404).json({ error: "Agent not found." });
      response.status(200).json({ agent: await AgentProfile.hydrate(agent) });
    })
  );

  router.post(
    "/agents",
    [requireCapability("agents:manage")],
    safeHandler(async (request, response) => {
      const body = reqBody(request);
      const result = await AgentProfile.create({
        ...body,
        actor: response.locals.user,
      });
      if (!result.agent)
        return response.status(400).json({ error: result.error });
      response
        .status(200)
        .json({ agent: await AgentProfile.hydrate(result.agent) });
    })
  );

  router.post(
    "/agents/:uuid",
    [requireCapability("agents:manage")],
    safeHandler(async (request, response) => {
      const result = await AgentProfile.update({
        uuid: String(request.params.uuid),
        patch: reqBody(request),
        actor: response.locals.user,
      });
      if (!result.success)
        return response.status(400).json({ error: result.error });
      response
        .status(200)
        .json({ agent: await AgentProfile.hydrate(result.agent) });
    })
  );

  router.delete(
    "/agents/:uuid",
    [requireCapability("agents:manage")],
    safeHandler(async (request, response) => {
      const result = await AgentProfile.delete({
        uuid: String(request.params.uuid),
        actor: response.locals.user,
      });
      if (!result.success)
        return response.status(400).json({ error: result.error });
      response.status(200).json({ success: true });
    })
  );

  /**
   * Website Agent (embed) management. Wraps upstream's embed configs so the
   * business sees "put my AI on my website" rather than embed internals.
   */
  router.get(
    "/website-agents",
    [requireCapability("agents:view")],
    safeHandler(async (_request, response) => {
      const { EmbedConfig } = require("../../models/embedConfig");
      const embeds = await EmbedConfig.whereWithWorkspace({});
      const agents = await AgentProfile.where({});
      const byWorkspace = new Map(agents.map((a) => [a.workspace_id, a]));

      const enriched = await Promise.all(
        embeds.map(async (embed) => {
          // `whereWithWorkspace` already aggregates the chat count for us.
          const chats = embed._count?.embed_chats ?? 0;
          const agent = byWorkspace.get(embed.workspace_id) ?? null;
          let allowlist = [];
          try {
            allowlist = JSON.parse(embed.allowlist_domains || "[]");
          } catch {
            allowlist = [];
          }
          return {
            uuid: embed.uuid,
            id: embed.id,
            enabled: embed.enabled,
            chatMode: embed.chat_mode,
            allowlistDomains: allowlist,
            // Surfaced prominently: an embed with no allowlist is the single
            // most likely way a business accidentally exposes its AI.
            allowlistConfigured: allowlist.length > 0,
            maxChatsPerDay: embed.max_chats_per_day,
            maxChatsPerSession: embed.max_chats_per_session,
            messageLimit: embed.message_limit,
            workspaceId: embed.workspace_id,
            workspaceName: embed.workspace?.name ?? null,
            agent: agent ? { uuid: agent.uuid, name: agent.name } : null,
            chatCount: chats,
            createdAt: embed.createdAt,
          };
        })
      );

      response.status(200).json({
        websiteAgents: enriched,
        requireAllowlist: config.security.requireEmbedAllowlist,
      });
    })
  );

  router.post(
    "/website-agents",
    [requireCapability("embeds:manage")],
    safeHandler(async (request, response) => {
      const { EmbedConfig } = require("../../models/embedConfig");
      const body = reqBody(request);

      const agent = body.agentUuid
        ? await AgentProfile.get({ uuid: String(body.agentUuid) })
        : null;
      if (!agent)
        return response.status(400).json({
          error: "Select the AI agent this website agent should use.",
        });

      const domains = Array.isArray(body.allowlistDomains)
        ? body.allowlistDomains.map((d) => String(d).trim()).filter(Boolean)
        : [];

      // Secure by default: refuse to create an unrestricted public embed when
      // the deployment requires allowlists.
      if (config.security.requireEmbedAllowlist && !domains.length)
        return response.status(400).json({
          error:
            "Add at least one allowed website domain. Public agents cannot be created without a domain allowlist on this deployment.",
        });

      const { embed, message } = await EmbedConfig.new(
        {
          workspace_id: agent.workspace_id,
          chat_mode: body.chatMode === "chat" ? "chat" : "query",
          // Pass the array as-is: EmbedConfig normalizes each entry to a URL
          // and JSON-encodes it. Pre-stringifying makes its comma-splitting
          // path drop every domain.
          allowlist_domains: domains,
          max_chats_per_day: body.maxChatsPerDay ?? 200,
          max_chats_per_session: body.maxChatsPerSession ?? 30,
          message_limit: body.messageLimit ?? 20,
          // Overrides stay off: a public visitor must never be able to change
          // the model, temperature or system prompt.
          allow_model_override: false,
          allow_temperature_override: false,
          allow_prompt_override: false,
        },
        response.locals.user?.id ?? null
      );

      if (!embed) return response.status(400).json({ error: message });

      await AuditLog.fromRequest(request, response, {
        action: "embed.created",
        category: AuditLog.CATEGORIES.EMBEDS,
        resource: "website_agent",
        resourceId: embed.uuid,
        metadata: { agent: agent.name, domains },
      });

      response
        .status(200)
        .json({ websiteAgent: { uuid: embed.uuid, id: embed.id } });
    })
  );

  router.post(
    "/website-agents/:uuid",
    [requireCapability("embeds:manage")],
    safeHandler(async (request, response) => {
      const { EmbedConfig } = require("../../models/embedConfig");
      const body = reqBody(request);
      const embed = await EmbedConfig.get({
        uuid: String(request.params.uuid),
      });
      if (!embed)
        return response.status(404).json({ error: "Website agent not found." });

      const updates = {};
      if (body.enabled !== undefined) updates.enabled = Boolean(body.enabled);
      if (body.chatMode !== undefined)
        updates.chat_mode = body.chatMode === "chat" ? "chat" : "query";
      if (body.maxChatsPerDay !== undefined)
        updates.max_chats_per_day = Number(body.maxChatsPerDay);
      if (body.maxChatsPerSession !== undefined)
        updates.max_chats_per_session = Number(body.maxChatsPerSession);
      if (body.messageLimit !== undefined)
        updates.message_limit = Number(body.messageLimit);

      if (body.allowlistDomains !== undefined) {
        const domains = (
          Array.isArray(body.allowlistDomains) ? body.allowlistDomains : []
        )
          .map((d) => String(d).trim())
          .filter(Boolean);
        if (config.security.requireEmbedAllowlist && !domains.length)
          return response.status(400).json({
            error:
              "At least one allowed domain is required. Removing every domain would expose this agent to any website.",
          });
        updates.allowlist_domains = domains;
      }

      const { success, error } = await EmbedConfig.update(embed.id, updates);
      if (!success) return response.status(400).json({ error });

      await AuditLog.fromRequest(request, response, {
        action: "embed.updated",
        category: AuditLog.CATEGORIES.EMBEDS,
        resource: "website_agent",
        resourceId: embed.uuid,
        metadata: { fields: Object.keys(updates) },
      });

      response.status(200).json({ success: true });
    })
  );

  router.delete(
    "/website-agents/:uuid",
    [requireCapability("embeds:manage")],
    safeHandler(async (request, response) => {
      const { EmbedConfig } = require("../../models/embedConfig");
      const embed = await EmbedConfig.get({
        uuid: String(request.params.uuid),
      });
      if (!embed)
        return response.status(404).json({ error: "Website agent not found." });

      await EmbedConfig.delete({ id: embed.id });
      await AuditLog.fromRequest(request, response, {
        action: "embed.removed",
        category: AuditLog.CATEGORIES.EMBEDS,
        resource: "website_agent",
        resourceId: embed.uuid,
      });
      response.status(200).json({ success: true });
    })
  );

  /** The copy-and-paste snippet for the customer's website. */
  router.get(
    "/website-agents/:uuid/snippet",
    [requireCapability("agents:view")],
    safeHandler(async (request, response) => {
      const { EmbedConfig } = require("../../models/embedConfig");
      const embed = await EmbedConfig.get({
        uuid: String(request.params.uuid),
      });
      if (!embed)
        return response.status(404).json({ error: "Website agent not found." });

      const base =
        config.deployment.publicUrl ||
        `${request.headers["x-forwarded-proto"] ?? request.protocol}://${
          request.headers["x-forwarded-host"] ?? request.get("host")
        }`;

      const brand = config.branding;
      const snippet = `<script
  data-embed-id="${embed.uuid}"
  data-base-api-url="${base}/api/embed"
  data-button-color="${brand.primaryColor}"
  data-assistant-name="${brand.companyName} Assistant"
  data-greeting="Hi! How can I help you today?"
  data-position="bottom-right"
  data-no-sponsor="true"
  src="${base}/embed/platform-chat-widget.min.js">
</script>`;

      response
        .status(200)
        .json({ snippet, embedId: embed.uuid, baseUrl: base });
    })
  );
}

module.exports = { agentRoutes };

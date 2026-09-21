const { v4: uuidv4 } = require("uuid");
const prisma = require("../../utils/prisma");
const { AuditLog } = require("./audit");
const { Lead } = require("./lead");
const config = require("../config");

/**
 * The business-facing "AI Agent".
 *
 * An agent is a thin productization layer over an upstream workspace: the
 * workspace continues to own the system prompt, model, temperature and
 * document attachments (so RAG, agents and citations behave exactly as
 * upstream), while this record owns the commercial concerns - templates,
 * lead capture, escalation and public exposure.
 */

const DEFAULT_FALLBACK =
  "I couldn't find that information in the approved company knowledge.";

const VISIBILITY = Object.freeze({ PRIVATE: "private", PUBLIC: "public" });

/**
 * Starter templates. Each expresses a real business job and configures the
 * underlying workspace so the agent is useful immediately.
 */
const TEMPLATES = Object.freeze({
  customer_support: {
    label: "Customer Support Agent",
    description:
      "Answers customer questions from your approved company knowledge.",
    visibility: VISIBILITY.PUBLIC,
    chatMode: "query",
    temperature: 0.2,
    leadCapture: true,
    escalation: true,
    systemPrompt: `You are the customer support assistant for {{COMPANY}}.

Answer only from the approved company knowledge provided to you. Be accurate, concise and professional.

Rules:
- If the knowledge does not contain the answer, say so plainly and offer to connect the customer with a person. Never invent policies, prices, availability or commitments.
- Cite the source documents you used when they are available.
- Do not speculate about anything outside the provided knowledge.
- Keep answers short and practical. Use a friendly, businesslike tone.`,
  },
  sales_qualification: {
    label: "Sales Qualification Agent",
    description:
      "Qualifies inbound inquiries and captures leads for your sales team.",
    visibility: VISIBILITY.PUBLIC,
    chatMode: "query",
    temperature: 0.3,
    leadCapture: true,
    escalation: true,
    systemPrompt: `You are the sales assistant for {{COMPANY}}.

Help prospective customers understand what {{COMPANY}} offers, using only the approved company knowledge.

Rules:
- Answer product and service questions accurately from the knowledge provided.
- Never quote a price, discount, delivery date or contractual term that is not in the approved knowledge.
- When a visitor shows genuine buying intent, offer to have someone from the team follow up and collect their contact details once - do not ask repeatedly.
- If a question needs a human, offer to connect them rather than guessing.`,
  },
  internal_knowledge: {
    label: "Internal Knowledge Agent",
    description:
      "Lets employees search internal company knowledge conversationally.",
    visibility: VISIBILITY.PRIVATE,
    chatMode: "query",
    temperature: 0.2,
    leadCapture: false,
    escalation: false,
    systemPrompt: `You are the internal knowledge assistant for {{COMPANY}} employees.

Answer questions using the internal company knowledge provided to you.

Rules:
- Answer only from the provided knowledge and cite the source documents.
- If the knowledge does not cover the question, say so and suggest who or which team is likely to know.
- Be direct and specific. Employees want the answer, not a preamble.`,
  },
  employee_assistant: {
    label: "Employee Assistant",
    description:
      "Helps staff with policies, processes and day-to-day internal questions.",
    visibility: VISIBILITY.PRIVATE,
    chatMode: "chat",
    temperature: 0.4,
    leadCapture: false,
    escalation: false,
    systemPrompt: `You are the employee assistant for {{COMPANY}}.

Help staff with internal policies, processes, onboarding and everyday questions.

Rules:
- Prefer the approved internal knowledge, and cite it when you use it.
- Be explicit when an answer comes from general knowledge rather than company policy.
- Never state a company policy, benefit or entitlement that is not in the approved knowledge.
- For HR, legal, payroll or compliance matters, point the employee to the responsible team.`,
  },
  website_concierge: {
    label: "Website Concierge",
    description: "Greets website visitors, routes them and captures interest.",
    visibility: VISIBILITY.PUBLIC,
    chatMode: "query",
    temperature: 0.3,
    leadCapture: true,
    escalation: true,
    systemPrompt: `You are the website concierge for {{COMPANY}}.

Greet visitors, understand what they need and get them to the right answer quickly.

Rules:
- Answer from the approved company knowledge only.
- Keep replies short - a sentence or two, then a question to move things forward.
- Offer a human handoff when the visitor asks for one or when the knowledge cannot answer them.
- Never invent details about products, pricing or the company.`,
  },
});

function clean(value, max = 255) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text.length ? text.slice(0, max) : null;
}

const AgentProfile = {
  TEMPLATES,
  VISIBILITY,
  DEFAULT_FALLBACK,

  templateCatalogue() {
    return Object.entries(TEMPLATES).map(([key, template]) => ({
      key,
      label: template.label,
      description: template.description,
      visibility: template.visibility,
      leadCapture: template.leadCapture,
      escalation: template.escalation,
    }));
  },

  /** Substitutes deployment values into a template prompt. */
  renderPrompt(prompt) {
    const company =
      config.customer.name || config.branding.companyName || "the company";
    return String(prompt).replace(/\{\{COMPANY\}\}/g, company);
  },

  /**
   * Creates an agent and the workspace that backs it.
   * @param {{name: string, description?: string, template?: string, systemPrompt?: string, model?: string, provider?: string, temperature?: number, visibility?: string, fallbackMessage?: string, leadCapture?: boolean, escalation?: boolean, escalationTarget?: string, actor?: object}} params
   */
  create: async function (params = {}) {
    const { Workspace } = require("../../models/workspace");
    const name = clean(params.name, 160);
    if (!name) return { agent: null, error: "An agent name is required." };

    const template = TEMPLATES[params.template] ?? null;
    const visibility =
      params.visibility === VISIBILITY.PUBLIC ||
      (params.visibility === undefined &&
        template?.visibility === VISIBILITY.PUBLIC)
        ? VISIBILITY.PUBLIC
        : VISIBILITY.PRIVATE;

    if (visibility === VISIBILITY.PUBLIC) {
      const check = await this.publicAgentSlotAvailable();
      if (!check.available) return { agent: null, error: check.reason };
    }

    const systemPrompt = this.renderPrompt(
      params.systemPrompt ?? template?.systemPrompt ?? ""
    );
    const fallback = clean(params.fallbackMessage, 1_000) ?? DEFAULT_FALLBACK;

    try {
      const { workspace, message: workspaceError } = await Workspace.new(
        name,
        params.actor?.id ?? null,
        {
          openAiPrompt: systemPrompt || null,
          openAiTemp:
            params.temperature !== undefined
              ? Number(params.temperature)
              : template?.temperature ?? null,
          chatMode: params.chatMode ?? template?.chatMode ?? "query",
          // The refusal response is what upstream returns when query mode finds
          // no sources - exactly the "approved knowledge only" behaviour.
          queryRefusalResponse: fallback,
          ...(params.provider ? { chatProvider: params.provider } : {}),
          ...(params.model ? { chatModel: params.model } : {}),
        }
      );

      if (!workspace)
        return {
          agent: null,
          error: workspaceError ?? "Unable to create the workspace.",
        };

      const agent = await prisma.agent_profiles.create({
        data: {
          uuid: uuidv4(),
          name,
          description: clean(params.description, 1_000),
          avatar_url: clean(params.avatarUrl, 1_000),
          template: params.template
            ? String(params.template).slice(0, 60)
            : null,
          workspace_id: workspace.id,
          active: params.active === undefined ? true : Boolean(params.active),
          visibility,
          fallback_message: fallback,
          lead_capture_enabled: Boolean(
            params.leadCapture ?? template?.leadCapture ?? false
          ),
          lead_capture_fields: JSON.stringify(
            Array.isArray(params.leadCaptureFields) &&
              params.leadCaptureFields.length
              ? params.leadCaptureFields.filter((f) =>
                  Lead.CONFIGURABLE_FIELDS.includes(f)
                )
              : [...Lead.DEFAULT_REQUIRED_FIELDS]
          ),
          escalation_enabled: Boolean(
            params.escalation ?? template?.escalation ?? false
          ),
          escalation_target: clean(params.escalationTarget, 500),
          createdBy: params.actor?.id ? Number(params.actor.id) : null,
        },
      });

      await AuditLog.log({
        action: "agent.created",
        category: AuditLog.CATEGORIES.AGENTS,
        actor: params.actor ?? null,
        resource: "agent",
        resourceId: agent.uuid,
        metadata: {
          name,
          template: params.template ?? null,
          visibility,
          workspaceSlug: workspace.slug,
        },
      });

      return { agent, workspace, error: null };
    } catch (error) {
      console.error("[AgentProfile] create failed:", error.message);
      return { agent: null, error: "Unable to create the agent." };
    }
  },

  /**
   * Updates an agent and, where relevant, the workspace behind it.
   * System-instruction changes are audited separately because they alter what
   * the business tells its customers.
   */
  update: async function ({ uuid, patch = {}, actor = null }) {
    const { Workspace } = require("../../models/workspace");
    try {
      const existing = await prisma.agent_profiles.findUnique({
        where: { uuid: String(uuid) },
      });
      if (!existing) return { success: false, error: "Agent not found." };

      const workspace = await Workspace.get({ id: existing.workspace_id });
      if (!workspace)
        return { success: false, error: "Backing workspace is missing." };

      // Promoting to public consumes one of the included public-agent slots.
      if (
        patch.visibility === VISIBILITY.PUBLIC &&
        existing.visibility !== VISIBILITY.PUBLIC
      ) {
        const check = await this.publicAgentSlotAvailable();
        if (!check.available) return { success: false, error: check.reason };
      }

      const agentData = { lastUpdatedAt: new Date() };
      if (patch.name !== undefined) agentData.name = clean(patch.name, 160);
      if (patch.description !== undefined)
        agentData.description = clean(patch.description, 1_000);
      if (patch.avatarUrl !== undefined)
        agentData.avatar_url = clean(patch.avatarUrl, 1_000);
      if (patch.active !== undefined) agentData.active = Boolean(patch.active);
      if (patch.visibility !== undefined)
        agentData.visibility =
          patch.visibility === VISIBILITY.PUBLIC
            ? VISIBILITY.PUBLIC
            : VISIBILITY.PRIVATE;
      if (patch.fallbackMessage !== undefined)
        agentData.fallback_message =
          clean(patch.fallbackMessage, 1_000) ?? DEFAULT_FALLBACK;
      if (patch.leadCapture !== undefined)
        agentData.lead_capture_enabled = Boolean(patch.leadCapture);
      if (patch.leadCaptureFields !== undefined)
        agentData.lead_capture_fields = JSON.stringify(
          (Array.isArray(patch.leadCaptureFields)
            ? patch.leadCaptureFields
            : []
          ).filter((f) => Lead.CONFIGURABLE_FIELDS.includes(f))
        );
      if (patch.escalation !== undefined)
        agentData.escalation_enabled = Boolean(patch.escalation);
      if (patch.escalationTarget !== undefined)
        agentData.escalation_target = clean(patch.escalationTarget, 500);

      // Workspace-owned settings.
      const workspaceData = {};
      if (patch.systemPrompt !== undefined)
        workspaceData.openAiPrompt = this.renderPrompt(
          patch.systemPrompt ?? ""
        );
      if (patch.temperature !== undefined)
        workspaceData.openAiTemp = Number(patch.temperature);
      if (patch.model !== undefined)
        workspaceData.chatModel = patch.model || null;
      if (patch.provider !== undefined)
        workspaceData.chatProvider = patch.provider || null;
      if (patch.chatMode !== undefined)
        workspaceData.chatMode = patch.chatMode === "chat" ? "chat" : "query";
      if (agentData.fallback_message !== undefined)
        workspaceData.queryRefusalResponse = agentData.fallback_message;

      const agent = await prisma.agent_profiles.update({
        where: { uuid: String(uuid) },
        data: agentData,
      });

      if (Object.keys(workspaceData).length)
        await Workspace.update(workspace.id, workspaceData);

      if (
        patch.systemPrompt !== undefined &&
        workspaceData.openAiPrompt !== workspace.openAiPrompt
      ) {
        await AuditLog.log({
          action: "agent.system_instructions_modified",
          category: AuditLog.CATEGORIES.AGENTS,
          actor,
          resource: "agent",
          resourceId: uuid,
          metadata: {
            name: agent.name,
            previousLength: workspace.openAiPrompt?.length ?? 0,
            newLength: workspaceData.openAiPrompt?.length ?? 0,
          },
        });
      }

      await AuditLog.log({
        action: "agent.updated",
        category: AuditLog.CATEGORIES.AGENTS,
        actor,
        resource: "agent",
        resourceId: uuid,
        metadata: { name: agent.name, fields: Object.keys(patch) },
      });

      return { success: true, agent };
    } catch (error) {
      console.error("[AgentProfile] update failed:", error.message);
      return { success: false, error: "Unable to update the agent." };
    }
  },

  get: async function (clause = {}) {
    try {
      return await prisma.agent_profiles.findFirst({ where: clause });
    } catch (error) {
      console.error(error.message);
      return null;
    }
  },

  where: async function (clause = {}) {
    try {
      return await prisma.agent_profiles.findMany({
        where: clause,
        orderBy: { id: "asc" },
      });
    } catch (error) {
      console.error(error.message);
      return [];
    }
  },

  count: async function (clause = {}) {
    try {
      return await prisma.agent_profiles.count({ where: clause });
    } catch (error) {
      console.error(error.message);
      return 0;
    }
  },

  /**
   * Deletes the agent record. The backing workspace and its documents are
   * deliberately NOT deleted - business knowledge is never destroyed as a side
   * effect of removing an agent.
   */
  delete: async function ({ uuid, actor = null }) {
    try {
      const existing = await prisma.agent_profiles.findUnique({
        where: { uuid: String(uuid) },
      });
      if (!existing) return { success: false, error: "Agent not found." };

      await prisma.agent_profiles.delete({ where: { uuid: String(uuid) } });
      await AuditLog.log({
        action: "agent.removed",
        category: AuditLog.CATEGORIES.AGENTS,
        actor,
        resource: "agent",
        resourceId: uuid,
        metadata: {
          name: existing.name,
          note: "Workspace and documents retained.",
          workspaceId: existing.workspace_id,
        },
      });
      return { success: true };
    } catch (error) {
      console.error("[AgentProfile] delete failed:", error.message);
      return { success: false, error: "Unable to remove the agent." };
    }
  },

  /** Enforces the included public-website-agent limit. */
  publicAgentSlotAvailable: async function () {
    const limit = config.limits.maxPublicAgents;
    if (!Number.isFinite(limit) || limit <= 0) return { available: true };
    const used = await this.count({ visibility: VISIBILITY.PUBLIC });
    if (used >= limit)
      return {
        available: false,
        reason: `This deployment includes ${limit} public website agents and all of them are in use. Deactivate one first.`,
      };
    return { available: true, used, limit };
  },

  /** Hydrates an agent with its workspace and embed state for the UI. */
  hydrate: async function (agent) {
    if (!agent) return null;
    const { Workspace } = require("../../models/workspace");
    const workspace = await Workspace.get({ id: agent.workspace_id });
    const embeds = await prisma.embed_configs.findMany({
      where: { workspace_id: agent.workspace_id },
    });
    const documentCount = await prisma.workspace_documents.count({
      where: { workspaceId: agent.workspace_id },
    });

    let leadCaptureFields = [...Lead.DEFAULT_REQUIRED_FIELDS];
    try {
      const parsed = JSON.parse(agent.lead_capture_fields || "[]");
      if (Array.isArray(parsed)) leadCaptureFields = parsed;
    } catch {
      /* keep the default */
    }

    return {
      uuid: agent.uuid,
      name: agent.name,
      description: agent.description,
      avatarUrl: agent.avatar_url,
      template: agent.template,
      active: agent.active,
      visibility: agent.visibility,
      fallbackMessage: agent.fallback_message,
      leadCapture: agent.lead_capture_enabled,
      leadCaptureFields,
      escalation: agent.escalation_enabled,
      escalationTarget: agent.escalation_target,
      createdAt: agent.createdAt,
      workspace: workspace
        ? {
            id: workspace.id,
            slug: workspace.slug,
            name: workspace.name,
            systemPrompt: workspace.openAiPrompt,
            temperature: workspace.openAiTemp,
            provider: workspace.chatProvider,
            model: workspace.chatModel,
            chatMode: workspace.chatMode,
            similarityThreshold: workspace.similarityThreshold,
            topN: workspace.topN,
          }
        : null,
      knowledge: { documentCount },
      embeds: embeds.map((embed) => ({
        uuid: embed.uuid,
        enabled: embed.enabled,
        allowlistDomains: embed.allowlist_domains,
        chatMode: embed.chat_mode,
        maxChatsPerDay: embed.max_chats_per_day,
        maxChatsPerSession: embed.max_chats_per_session,
      })),
    };
  },

  /** Resolves the agent that owns a given embed, if any. */
  forEmbed: async function (embed) {
    if (!embed?.workspace_id) return null;
    return this.get({ workspace_id: Number(embed.workspace_id) });
  },
};

module.exports = { AgentProfile, TEMPLATES, VISIBILITY };

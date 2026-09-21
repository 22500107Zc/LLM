const prisma = require("../../utils/prisma");

/**
 * Business analytics.
 *
 * Everything reported here is measured from data the platform actually holds.
 * Nothing is modelled, projected or monetized - where a number is an estimate
 * it is labelled as one so a business never mistakes it for a measurement.
 */

const WINDOWS = Object.freeze({ 7: 7, 30: 30, 90: 90 });

function windowStart(days, now = new Date()) {
  return new Date(now.getTime() - Number(days) * 24 * 60 * 60 * 1000);
}

function safeJSON(value, fallback = {}) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function percent(numerator, denominator) {
  if (!denominator) return 0;
  return Math.round((numerator / denominator) * 1000) / 10;
}

/**
 * Groups questions by their knowledge-gap normalization so "top questions"
 * reflects topics rather than exact strings.
 */
function topQuestions(prompts, limit = 10) {
  const { KnowledgeGaps } = require("./knowledgeGaps");
  const groups = new Map();

  for (const prompt of prompts) {
    const text = String(prompt ?? "").trim();
    if (text.length < 6) continue;
    const key = KnowledgeGaps.normalizeQuestion(text);
    if (!key) continue;
    const entry = groups.get(key) ?? { count: 0, example: text };
    entry.count += 1;
    // Keep the shortest phrasing as the representative example.
    if (text.length < entry.example.length) entry.example = text;
    groups.set(key, entry);
  }

  return [...groups.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, limit)
    .map((entry) => ({ question: entry.example, count: entry.count }));
}

const Analytics = {
  WINDOWS,
  topQuestions,

  /**
   * Builds the full analytics payload for a time window.
   * @param {number} days 7, 30 or 90
   */
  overview: async function (days = 30, now = new Date()) {
    const windowDays = WINDOWS[Number(days)] ?? 30;
    const since = windowStart(windowDays, now);
    const range = { gte: since };

    const [
      internalChats,
      publicChats,
      leadsTotal,
      leadsQualified,
      escalationsTotal,
      gapsOpen,
      automationRuns,
      automationFailures,
      agentProfiles,
    ] = await Promise.all([
      prisma.workspace_chats.findMany({
        where: { createdAt: range, include: true },
        select: {
          id: true,
          workspaceId: true,
          prompt: true,
          response: true,
          user_id: true,
          feedbackScore: true,
          createdAt: true,
        },
      }),
      prisma.embed_chats.findMany({
        where: { createdAt: range, include: true },
        select: {
          id: true,
          embed_id: true,
          prompt: true,
          response: true,
          session_id: true,
          createdAt: true,
        },
      }),
      prisma.leads.count({ where: { createdAt: range } }),
      prisma.leads.count({
        where: { createdAt: range, status: { in: ["qualified", "opportunity", "closed"] } },
      }),
      prisma.escalations.count({ where: { createdAt: range } }),
      prisma.knowledge_gaps.count({ where: { status: "open" } }),
      prisma.scheduled_job_runs.count({ where: { startedAt: range } }),
      prisma.scheduled_job_runs.count({
        where: { startedAt: range, status: { in: ["failed", "timed_out"] } },
      }),
      prisma.agent_profiles.findMany({
        select: { id: true, uuid: true, name: true, workspace_id: true, visibility: true },
      }),
    ]);

    // --- conversation counts -------------------------------------------------
    // A "conversation" is a session for public chats and a workspace+user pair
    // for internal chats; message counts are the raw exchanges.
    const publicSessions = new Set(publicChats.map((chat) => chat.session_id));
    const internalConversations = new Set(
      internalChats.map((chat) => `${chat.workspaceId}:${chat.user_id ?? "system"}`)
    );

    const aiMessages = internalChats.length + publicChats.length;

    // --- answer quality ------------------------------------------------------
    const { KnowledgeGaps } = require("./knowledgeGaps");
    let unanswered = 0;
    let answered = 0;
    const sourceUsage = new Map();

    const inspect = (chat) => {
      const parsed = safeJSON(chat.response, {});
      const text = parsed?.text ?? parsed?.textResponse ?? "";
      const sources = Array.isArray(parsed?.sources) ? parsed.sources : [];
      if (KnowledgeGaps.looksLikeRefusal(text)) unanswered += 1;
      else answered += 1;

      for (const source of sources.slice(0, 10)) {
        const title = source?.title ?? source?.metadata?.title ?? null;
        if (!title) continue;
        sourceUsage.set(title, (sourceUsage.get(title) ?? 0) + 1);
      }
    };
    internalChats.forEach(inspect);
    publicChats.forEach(inspect);

    // --- feedback ------------------------------------------------------------
    const positiveFeedback = internalChats.filter((c) => c.feedbackScore === true).length;
    const negativeFeedback = internalChats.filter((c) => c.feedbackScore === false).length;

    // --- per-agent usage -----------------------------------------------------
    const workspaceToAgent = new Map(
      agentProfiles.map((agent) => [agent.workspace_id, agent])
    );
    const embedConfigs = await prisma.embed_configs.findMany({
      select: { id: true, workspace_id: true },
    });
    const embedToWorkspace = new Map(embedConfigs.map((e) => [e.id, e.workspace_id]));

    const agentUsage = new Map();
    const bump = (workspaceId, key) => {
      const agent = workspaceToAgent.get(workspaceId);
      const name = agent?.name ?? `Workspace ${workspaceId}`;
      const id = agent?.uuid ?? `workspace-${workspaceId}`;
      const entry = agentUsage.get(id) ?? {
        id,
        name,
        internal: 0,
        public: 0,
        visibility: agent?.visibility ?? "private",
      };
      entry[key] += 1;
      agentUsage.set(id, entry);
    };
    internalChats.forEach((chat) => bump(chat.workspaceId, "internal"));
    publicChats.forEach((chat) => {
      const workspaceId = embedToWorkspace.get(chat.embed_id);
      if (workspaceId) bump(workspaceId, "public");
    });

    // --- per-user usage ------------------------------------------------------
    const userCounts = new Map();
    for (const chat of internalChats) {
      if (!chat.user_id) continue;
      userCounts.set(chat.user_id, (userCounts.get(chat.user_id) ?? 0) + 1);
    }
    const users = userCounts.size
      ? await prisma.users.findMany({
          where: { id: { in: [...userCounts.keys()] } },
          select: { id: true, username: true },
        })
      : [];
    const userUsage = users
      .map((user) => ({
        username: user.username,
        messages: userCounts.get(user.id) ?? 0,
      }))
      .sort((a, b) => b.messages - a.messages)
      .slice(0, 15);

    return {
      window: { days: windowDays, since: since.toISOString(), until: now.toISOString() },

      conversations: {
        total: internalConversations.size + publicSessions.size,
        internal: internalConversations.size,
        public: publicSessions.size,
        aiMessages,
        // Distinct public sessions are the closest honest proxy we have for
        // unique visitors - we do not fingerprint or track people.
        uniqueVisitors: publicSessions.size,
        uniqueVisitorsIsEstimate: true,
      },

      leads: {
        captured: leadsTotal,
        qualified: leadsQualified,
        conversionPercent: percent(leadsQualified, leadsTotal),
        // Leads per public conversation - labelled as an estimate because a
        // single visitor may hold several sessions.
        captureRatePercent: percent(leadsTotal, publicSessions.size),
        captureRateIsEstimate: true,
      },

      escalations: {
        total: escalationsTotal,
        ratePercent: percent(
          escalationsTotal,
          internalConversations.size + publicSessions.size
        ),
      },

      answers: {
        answered,
        unanswered,
        answeredPercent: percent(answered, answered + unanswered),
        positiveFeedback,
        negativeFeedback,
      },

      knowledge: {
        openGaps: gapsOpen,
        popularSources: [...sourceUsage.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10)
          .map(([title, count]) => ({ title, count })),
      },

      topQuestions: topQuestions([
        ...internalChats.map((c) => c.prompt),
        ...publicChats.map((c) => c.prompt),
      ]),

      agentUsage: [...agentUsage.values()].sort(
        (a, b) => b.internal + b.public - (a.internal + a.public)
      ),

      userUsage,

      automations: {
        executions: automationRuns,
        failures: automationFailures,
        failurePercent: percent(automationFailures, automationRuns),
      },
    };
  },

  /** Compact figures for the dashboard header. */
  dashboard: async function (now = new Date()) {
    const since = windowStart(30, now);
    const [chats, embedChats, leads, escalations, gaps, agents, documents] =
      await Promise.all([
        prisma.workspace_chats.count({ where: { createdAt: { gte: since } } }),
        prisma.embed_chats.count({ where: { createdAt: { gte: since } } }),
        prisma.leads.count({ where: { createdAt: { gte: since } } }),
        prisma.escalations.count({ where: { status: "open" } }),
        prisma.knowledge_gaps.count({ where: { status: "open" } }),
        prisma.agent_profiles.count({ where: { active: true } }),
        prisma.workspace_documents.count(),
      ]);

    return {
      windowDays: 30,
      aiMessages: chats + embedChats,
      internalMessages: chats,
      publicMessages: embedChats,
      newLeads: leads,
      openEscalations: escalations,
      openKnowledgeGaps: gaps,
      activeAgents: agents,
      documents,
    };
  },
};

module.exports = { Analytics };

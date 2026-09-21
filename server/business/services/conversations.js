const prisma = require("../../utils/prisma");
const { AuditLog } = require("../models/audit");

/**
 * Unified conversation management across both channels - internal workspace
 * chats and public website-agent chats - so a business reviews everything its
 * AI said in one place.
 */

const CHANNELS = Object.freeze({ INTERNAL: "internal", PUBLIC: "public" });

function safeJSON(value, fallback = {}) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function answerText(response) {
  const parsed = safeJSON(response, {});
  return parsed?.text ?? parsed?.textResponse ?? "";
}

/**
 * Builds an extractive summary. Deliberately not an LLM call - summarizing
 * every conversation with the model would spend the customer's inference
 * budget on bookkeeping. The transcript view shows the full exchange.
 */
function summarize(turns = []) {
  const firstQuestion = turns.find((turn) => turn.prompt)?.prompt ?? "";
  const lastAnswer =
    [...turns].reverse().find((turn) => turn.answer)?.answer ?? "";
  const opening = String(firstQuestion)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
  const closing = String(lastAnswer).replace(/\s+/g, " ").trim().slice(0, 180);
  if (!opening) return "No visitor message recorded.";
  return `Asked about: "${opening}"${closing ? ` — Last reply: "${closing}"` : ""}`;
}

const Conversations = {
  CHANNELS,
  summarize,

  /**
   * Lists conversations with filtering and search.
   * @param {{channel?: string, search?: string, days?: number, reviewed?: boolean|null, escalatedOnly?: boolean, leadsOnly?: boolean, limit?: number, offset?: number}} options
   */
  list: async function (options = {}) {
    const limit = Math.min(Number(options.limit) || 50, 200);
    const offset = Number(options.offset) || 0;
    const since = options.days
      ? new Date(Date.now() - Number(options.days) * 86_400_000)
      : null;
    const search = options.search
      ? String(options.search).toLowerCase().trim()
      : null;

    const timeFilter = since ? { createdAt: { gte: since } } : {};
    const wantInternal =
      !options.channel || options.channel === CHANNELS.INTERNAL;
    const wantPublic = !options.channel || options.channel === CHANNELS.PUBLIC;

    const [
      internalRows,
      publicRows,
      agents,
      embedConfigs,
      reviews,
      leads,
      escalations,
    ] = await Promise.all([
      wantInternal
        ? prisma.workspace_chats.findMany({
            where: { ...timeFilter, include: true },
            select: {
              id: true,
              workspaceId: true,
              prompt: true,
              response: true,
              user_id: true,
              thread_id: true,
              feedbackScore: true,
              createdAt: true,
            },
            orderBy: { createdAt: "asc" },
          })
        : [],
      wantPublic
        ? prisma.embed_chats.findMany({
            where: { ...timeFilter, include: true },
            select: {
              id: true,
              embed_id: true,
              prompt: true,
              response: true,
              session_id: true,
              connection_information: true,
              createdAt: true,
            },
            orderBy: { createdAt: "asc" },
          })
        : [],
      prisma.agent_profiles.findMany({
        select: { uuid: true, name: true, workspace_id: true },
      }),
      prisma.embed_configs.findMany({
        select: { id: true, workspace_id: true, uuid: true },
      }),
      prisma.conversation_reviews.findMany(),
      prisma.leads.findMany({ select: { session_id: true } }),
      prisma.escalations.findMany({ select: { session_id: true } }),
    ]);

    const agentByWorkspace = new Map(agents.map((a) => [a.workspace_id, a]));
    const embedById = new Map(embedConfigs.map((e) => [e.id, e]));
    const reviewByKey = new Map(
      reviews.map((r) => [`${r.channel}:${r.reference_id}`, r])
    );
    const leadSessions = new Set(
      leads.map((l) => l.session_id).filter(Boolean)
    );
    const escalatedSessions = new Set(
      escalations.map((e) => e.session_id).filter(Boolean)
    );

    // Group raw exchanges into conversations.
    const grouped = new Map();

    for (const row of internalRows) {
      const key = `${row.workspaceId}:${row.user_id ?? "system"}:${row.thread_id ?? "main"}`;
      const agent = agentByWorkspace.get(row.workspaceId);
      const entry = grouped.get(`internal|${key}`) ?? {
        channel: CHANNELS.INTERNAL,
        referenceId: key,
        agentName: agent?.name ?? `Workspace ${row.workspaceId}`,
        agentUuid: agent?.uuid ?? null,
        workspaceId: row.workspaceId,
        userId: row.user_id,
        sessionId: null,
        turns: [],
        firstAt: row.createdAt,
        lastAt: row.createdAt,
        feedback: { positive: 0, negative: 0 },
      };
      entry.turns.push({
        prompt: row.prompt,
        answer: answerText(row.response),
        at: row.createdAt,
        feedback: row.feedbackScore,
      });
      if (row.feedbackScore === true) entry.feedback.positive += 1;
      if (row.feedbackScore === false) entry.feedback.negative += 1;
      entry.lastAt = row.createdAt;
      grouped.set(`internal|${key}`, entry);
    }

    for (const row of publicRows) {
      const embed = embedById.get(row.embed_id);
      const agent = embed ? agentByWorkspace.get(embed.workspace_id) : null;
      const key = row.session_id;
      const connection = safeJSON(row.connection_information, {});
      const entry = grouped.get(`public|${key}`) ?? {
        channel: CHANNELS.PUBLIC,
        referenceId: key,
        agentName:
          agent?.name ??
          (embed ? `Embed ${embed.uuid.slice(0, 8)}` : "Unknown agent"),
        agentUuid: agent?.uuid ?? null,
        workspaceId: embed?.workspace_id ?? null,
        userId: null,
        sessionId: row.session_id,
        sourceHost: connection?.host ?? null,
        turns: [],
        firstAt: row.createdAt,
        lastAt: row.createdAt,
        feedback: { positive: 0, negative: 0 },
      };
      entry.turns.push({
        prompt: row.prompt,
        answer: answerText(row.response),
        at: row.createdAt,
      });
      entry.lastAt = row.createdAt;
      grouped.set(`public|${key}`, entry);
    }

    let conversations = [...grouped.values()].map((entry) => {
      const review = reviewByKey.get(`${entry.channel}:${entry.referenceId}`);
      return {
        channel: entry.channel,
        referenceId: entry.referenceId,
        agentName: entry.agentName,
        agentUuid: entry.agentUuid,
        visitor:
          entry.channel === CHANNELS.PUBLIC
            ? `Visitor ${String(entry.sessionId ?? "").slice(0, 8)}`
            : entry.userId
              ? `User #${entry.userId}`
              : "System",
        sourceHost: entry.sourceHost ?? null,
        messageCount: entry.turns.length,
        startedAt: entry.firstAt,
        lastMessageAt: entry.lastAt,
        leadGenerated: entry.sessionId
          ? leadSessions.has(entry.sessionId)
          : false,
        escalated: entry.sessionId
          ? escalatedSessions.has(entry.sessionId)
          : false,
        feedback: entry.feedback,
        reviewed: Boolean(review?.reviewed),
        reviewedAt: review?.reviewed_at ?? null,
        note: review?.note ?? null,
        summary: review?.summary ?? summarize(entry.turns),
        turns: entry.turns,
      };
    });

    if (search)
      conversations = conversations.filter((conversation) =>
        conversation.turns.some(
          (turn) =>
            String(turn.prompt ?? "")
              .toLowerCase()
              .includes(search) ||
            String(turn.answer ?? "")
              .toLowerCase()
              .includes(search)
        )
      );

    if (options.reviewed === true)
      conversations = conversations.filter((c) => c.reviewed);
    if (options.reviewed === false)
      conversations = conversations.filter((c) => !c.reviewed);
    if (options.escalatedOnly)
      conversations = conversations.filter((c) => c.escalated);
    if (options.leadsOnly)
      conversations = conversations.filter((c) => c.leadGenerated);

    conversations.sort(
      (a, b) =>
        new Date(b.lastMessageAt).getTime() -
        new Date(a.lastMessageAt).getTime()
    );

    const total = conversations.length;
    const page = conversations.slice(offset, offset + limit);

    return {
      total,
      offset,
      limit,
      // The list view does not need full transcripts.
      // The list view drops transcripts; they are fetched per conversation.
      conversations: page.map(({ turns: _turns, ...rest }) => rest),
    };
  },

  /** Full transcript for one conversation, including per-answer citations. */
  transcript: async function ({ channel, referenceId }) {
    return (await this._withTurns({ channel, referenceId })) ?? null;
  },

  /** Internal helper - rebuilds one conversation including its turns. */
  _withTurns: async function ({ channel, referenceId }) {
    const listing = await this.list({ channel, limit: 500 });
    const match = listing.conversations.find(
      (c) => c.referenceId === referenceId
    );
    if (!match) return null;

    // Re-fetch the turns for just this conversation.
    if (channel === CHANNELS.PUBLIC) {
      const rows = await prisma.embed_chats.findMany({
        where: { session_id: String(referenceId), include: true },
        orderBy: { createdAt: "asc" },
      });
      return {
        ...match,
        turns: rows.map((row) => ({
          prompt: row.prompt,
          answer: answerText(row.response),
          sources: safeJSON(row.response, {})?.sources ?? [],
          at: row.createdAt,
        })),
      };
    }

    const [workspaceId, userId, threadId] = String(referenceId).split(":");
    const rows = await prisma.workspace_chats.findMany({
      where: {
        workspaceId: Number(workspaceId),
        user_id: userId === "system" ? null : Number(userId),
        thread_id: threadId === "main" ? null : Number(threadId),
        include: true,
      },
      orderBy: { createdAt: "asc" },
    });
    return {
      ...match,
      turns: rows.map((row) => ({
        prompt: row.prompt,
        answer: answerText(row.response),
        sources: safeJSON(row.response, {})?.sources ?? [],
        feedback: row.feedbackScore,
        at: row.createdAt,
      })),
    };
  },

  /** Marks a conversation reviewed and optionally attaches a note. */
  review: async function ({
    channel,
    referenceId,
    reviewed = true,
    note = null,
    actor = null,
  }) {
    try {
      const record = await prisma.conversation_reviews.upsert({
        where: {
          channel_reference_id: {
            channel: String(channel),
            reference_id: String(referenceId),
          },
        },
        update: {
          reviewed: Boolean(reviewed),
          reviewed_by: actor?.id ? Number(actor.id) : null,
          reviewed_at: reviewed ? new Date() : null,
          ...(note !== null ? { note: String(note).slice(0, 4_000) } : {}),
          lastUpdatedAt: new Date(),
        },
        create: {
          channel: String(channel),
          reference_id: String(referenceId),
          reviewed: Boolean(reviewed),
          reviewed_by: actor?.id ? Number(actor.id) : null,
          reviewed_at: reviewed ? new Date() : null,
          note: note ? String(note).slice(0, 4_000) : null,
        },
      });

      await AuditLog.log({
        action: "conversation.reviewed",
        category: AuditLog.CATEGORIES.GENERAL,
        actor,
        resource: "conversation",
        resourceId: `${channel}:${referenceId}`,
        metadata: { reviewed: Boolean(reviewed) },
      });
      return { success: true, review: record };
    } catch (error) {
      console.error("[Conversations] review failed:", error.message);
      return { success: false, error: "Unable to update the review state." };
    }
  },

  /** CSV export of the conversation list. */
  toCSV: function (conversations = []) {
    const escape = (value) => {
      if (value === null || value === undefined) return "";
      let text = String(value);
      if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
      return `"${text.replace(/"/g, '""')}"`;
    };
    const header = [
      "started_at",
      "last_message_at",
      "channel",
      "agent",
      "visitor",
      "messages",
      "lead_generated",
      "escalated",
      "reviewed",
      "positive_feedback",
      "negative_feedback",
      "summary",
    ].join(",");
    const rows = conversations.map((c) =>
      [
        new Date(c.startedAt).toISOString(),
        new Date(c.lastMessageAt).toISOString(),
        c.channel,
        c.agentName,
        c.visitor,
        c.messageCount,
        c.leadGenerated,
        c.escalated,
        c.reviewed,
        c.feedback?.positive ?? 0,
        c.feedback?.negative ?? 0,
        c.summary,
      ]
        .map(escape)
        .join(",")
    );
    return [header, ...rows].join("\n");
  },
};

module.exports = { Conversations, CHANNELS };

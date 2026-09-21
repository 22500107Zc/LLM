const { v4: uuidv4 } = require("uuid");
const prisma = require("../../utils/prisma");
const { AuditLog } = require("./audit");

/**
 * Human escalation records.
 *
 * This is deliberately NOT a helpdesk. It captures who needs help, what they
 * asked, and enough transcript for a human to take over - then hands it to the
 * business's existing tools over email, webhook or Slack.
 */

const STATUSES = Object.freeze([
  "open",
  "acknowledged",
  "resolved",
  "dismissed",
]);
const REASONS = Object.freeze([
  "requested", // the visitor asked for a person
  "no_answer", // the AI could not answer from approved knowledge
  "negative_feedback",
  "manual",
]);

const MAX_TRANSCRIPT_CHARS = 20_000;

function clean(value, max = 255) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text.length ? text.slice(0, max) : null;
}

/** Renders a transcript array into a stable, readable text block. */
function renderTranscript(transcript) {
  if (!transcript) return null;
  if (typeof transcript === "string")
    return transcript.slice(0, MAX_TRANSCRIPT_CHARS);
  if (!Array.isArray(transcript)) return null;

  return transcript
    .slice(-40)
    .map((turn) => {
      const role = turn?.role === "assistant" ? "AI" : "Visitor";
      const content = String(turn?.content ?? turn?.text ?? "").slice(0, 2_000);
      return `${role}: ${content}`;
    })
    .join("\n")
    .slice(0, MAX_TRANSCRIPT_CHARS);
}

const Escalation = {
  STATUSES,
  REASONS,

  create: async function (payload = {}, options = {}) {
    const reason = REASONS.includes(String(payload.reason))
      ? String(payload.reason)
      : "requested";

    try {
      const escalation = await prisma.escalations.create({
        data: {
          uuid: uuidv4(),
          contact_name: clean(payload.contactName ?? payload.contact_name, 200),
          contact_email:
            clean(
              payload.contactEmail ?? payload.contact_email,
              255
            )?.toLowerCase() ?? null,
          contact_phone: clean(
            payload.contactPhone ?? payload.contact_phone,
            60
          ),
          question: clean(payload.question, 4_000),
          transcript: renderTranscript(payload.transcript),
          summary: clean(payload.summary, 4_000),
          agent_profile_id: payload.agentProfileId
            ? Number(payload.agentProfileId)
            : null,
          embed_id: payload.embedId ? Number(payload.embedId) : null,
          session_id: clean(payload.sessionId ?? payload.session_id, 120),
          source_url: clean(payload.sourceUrl ?? payload.source_url, 1_000),
          reason,
          status: "open",
        },
      });

      await AuditLog.log({
        action: "escalation.created",
        category: AuditLog.CATEGORIES.LEADS,
        actor: options.actor ?? null,
        resource: "escalation",
        resourceId: escalation.uuid,
        metadata: {
          reason,
          contactEmail: escalation.contact_email,
          agentProfileId: escalation.agent_profile_id,
        },
      });

      return { escalation, error: null };
    } catch (error) {
      console.error("[Escalation] create failed:", error.message);
      return { escalation: null, error: "Unable to create the escalation." };
    }
  },

  where: async function (clause = {}, limit = 100, offset = 0) {
    try {
      return await prisma.escalations.findMany({
        where: clause,
        take: Math.min(Number(limit) || 100, 500),
        skip: Number(offset) || 0,
        orderBy: { createdAt: "desc" },
      });
    } catch (error) {
      console.error(error.message);
      return [];
    }
  },

  count: async function (clause = {}) {
    try {
      return await prisma.escalations.count({ where: clause });
    } catch (error) {
      console.error(error.message);
      return 0;
    }
  },

  updateStatus: async function ({ uuid, status, actor = null }) {
    if (!STATUSES.includes(String(status)))
      return { success: false, error: "Unknown escalation status." };
    try {
      const escalation = await prisma.escalations.update({
        where: { uuid: String(uuid) },
        data: {
          status: String(status),
          resolved_at: ["resolved", "dismissed"].includes(String(status))
            ? new Date()
            : null,
          lastUpdatedAt: new Date(),
        },
      });
      await AuditLog.log({
        action: "escalation.status_changed",
        category: AuditLog.CATEGORIES.LEADS,
        actor,
        resource: "escalation",
        resourceId: uuid,
        metadata: { to: status },
      });
      return { success: true, escalation };
    } catch (error) {
      console.error("[Escalation] status update failed:", error.message);
      return { success: false, error: "Unable to update the escalation." };
    }
  },

  markDelivered: async function (id, { error = null } = {}) {
    try {
      await prisma.escalations.update({
        where: { id: Number(id) },
        data: {
          delivered: !error,
          delivery_error: error ? String(error).slice(0, 500) : null,
        },
      });
    } catch (e) {
      console.error("[Escalation] delivery flag failed:", e.message);
    }
  },

  _renderTranscript: renderTranscript,
};

module.exports = { Escalation };

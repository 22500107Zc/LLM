const { v4: uuidv4 } = require("uuid");
const prisma = require("../../utils/prisma");
const { AuditLog } = require("./audit");

/**
 * Native lead capture.
 *
 * Leads arrive from a public website agent (or an internal agent) and are the
 * commercial payload of the platform, so the record keeps enough context for a
 * salesperson to act without opening the transcript.
 */

const STATUSES = Object.freeze([
  "new",
  "qualified",
  "contacted",
  "opportunity",
  "closed",
  "disqualified",
]);

/** Fields an administrator may mark required on the capture form. */
const CONFIGURABLE_FIELDS = Object.freeze([
  "first_name",
  "last_name",
  "email",
  "company",
  "phone",
  "job_title",
  "reason",
]);

const DEFAULT_REQUIRED_FIELDS = Object.freeze(["first_name", "email"]);

const MAX_TEXT = 2_000;

function clean(value, max = 255) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text.length) return null;
  return text.slice(0, max);
}

/** Conservative email shape check - real validation is delivery. */
function validEmail(value) {
  if (!value) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(value).trim());
}

const Lead = {
  STATUSES,
  CONFIGURABLE_FIELDS,
  DEFAULT_REQUIRED_FIELDS,

  /**
   * Creates a lead. Validation is driven by the agent's configured required
   * fields so each business decides what it needs.
   * @param {object} payload
   * @param {{requiredFields?: string[], actor?: object|null}} options
   */
  create: async function (payload = {}, options = {}) {
    const required = Array.isArray(options.requiredFields) && options.requiredFields.length
      ? options.requiredFields.filter((f) => CONFIGURABLE_FIELDS.includes(f))
      : [...DEFAULT_REQUIRED_FIELDS];

    const data = {
      first_name: clean(payload.firstName ?? payload.first_name, 120),
      last_name: clean(payload.lastName ?? payload.last_name, 120),
      email: clean(payload.email, 255)?.toLowerCase() ?? null,
      company: clean(payload.company, 200),
      phone: clean(payload.phone, 60),
      job_title: clean(payload.jobTitle ?? payload.job_title, 160),
      reason: clean(payload.reason, MAX_TEXT),
      conversation_summary: clean(
        payload.conversationSummary ?? payload.conversation_summary,
        MAX_TEXT
      ),
      source_url: clean(payload.sourceUrl ?? payload.source_url, 1_000),
      session_id: clean(payload.sessionId ?? payload.session_id, 120),
    };

    const missing = required.filter((field) => !data[field]);
    if (missing.length)
      return { lead: null, error: `Missing required field(s): ${missing.join(", ")}.` };

    if (data.email && !validEmail(data.email))
      return { lead: null, error: "A valid email address is required." };

    try {
      const lead = await prisma.leads.create({
        data: {
          ...data,
          uuid: uuidv4(),
          agent_profile_id: payload.agentProfileId
            ? Number(payload.agentProfileId)
            : null,
          embed_id: payload.embedId ? Number(payload.embedId) : null,
          status: "new",
        },
      });

      await AuditLog.log({
        action: "lead.captured",
        category: AuditLog.CATEGORIES.LEADS,
        actor: options.actor ?? null,
        resource: "lead",
        resourceId: lead.uuid,
        // Contact details are business data, not credentials, but the summary
        // and transcript are deliberately excluded from the audit record.
        metadata: {
          email: lead.email,
          company: lead.company,
          agentProfileId: lead.agent_profile_id,
        },
      });

      return { lead, error: null };
    } catch (error) {
      console.error("[Lead] create failed:", error.message);
      return { lead: null, error: "Unable to save the lead." };
    }
  },

  get: async function (clause = {}) {
    try {
      return await prisma.leads.findFirst({ where: clause });
    } catch (error) {
      console.error(error.message);
      return null;
    }
  },

  where: async function (clause = {}, limit = 100, offset = 0, orderBy = null) {
    try {
      return await prisma.leads.findMany({
        where: clause,
        take: Math.min(Number(limit) || 100, 500),
        skip: Number(offset) || 0,
        orderBy: orderBy ?? { createdAt: "desc" },
      });
    } catch (error) {
      console.error(error.message);
      return [];
    }
  },

  count: async function (clause = {}) {
    try {
      return await prisma.leads.count({ where: clause });
    } catch (error) {
      console.error(error.message);
      return 0;
    }
  },

  updateStatus: async function ({ uuid, status, actor = null }) {
    if (!STATUSES.includes(String(status)))
      return { success: false, error: "Unknown lead status." };
    try {
      const existing = await prisma.leads.findUnique({ where: { uuid: String(uuid) } });
      if (!existing) return { success: false, error: "Lead not found." };

      const lead = await prisma.leads.update({
        where: { uuid: String(uuid) },
        data: { status: String(status), lastUpdatedAt: new Date() },
      });

      await AuditLog.log({
        action: "lead.status_changed",
        category: AuditLog.CATEGORIES.LEADS,
        actor,
        resource: "lead",
        resourceId: uuid,
        metadata: { from: existing.status, to: status },
      });
      return { success: true, lead };
    } catch (error) {
      console.error("[Lead] status update failed:", error.message);
      return { success: false, error: "Unable to update the lead." };
    }
  },

  addNote: async function ({ uuid, note, actor = null }) {
    try {
      const existing = await prisma.leads.findUnique({ where: { uuid: String(uuid) } });
      if (!existing) return { success: false, error: "Lead not found." };

      const stamp = new Date().toISOString();
      const author = actor?.username ?? "system";
      const entry = `[${stamp}] ${author}: ${String(note).slice(0, MAX_TEXT)}`;
      const combined = existing.notes ? `${existing.notes}\n${entry}` : entry;

      const lead = await prisma.leads.update({
        where: { uuid: String(uuid) },
        data: { notes: combined.slice(-20_000), lastUpdatedAt: new Date() },
      });

      await AuditLog.log({
        action: "lead.note_added",
        category: AuditLog.CATEGORIES.LEADS,
        actor,
        resource: "lead",
        resourceId: uuid,
      });
      return { success: true, lead };
    } catch (error) {
      console.error("[Lead] note failed:", error.message);
      return { success: false, error: "Unable to add the note." };
    }
  },

  markDelivered: async function (id, { error = null } = {}) {
    try {
      await prisma.leads.update({
        where: { id: Number(id) },
        data: { delivered: !error, delivery_error: error ? String(error).slice(0, 500) : null },
      });
    } catch (e) {
      console.error("[Lead] delivery flag failed:", e.message);
    }
  },

  /** CSV export for the leads dashboard. */
  toCSV: function (leads = []) {
    const columns = [
      ["uuid", (l) => l.uuid],
      ["created_at", (l) => new Date(l.createdAt).toISOString()],
      ["status", (l) => l.status],
      ["first_name", (l) => l.first_name],
      ["last_name", (l) => l.last_name],
      ["email", (l) => l.email],
      ["company", (l) => l.company],
      ["phone", (l) => l.phone],
      ["job_title", (l) => l.job_title],
      ["reason", (l) => l.reason],
      ["conversation_summary", (l) => l.conversation_summary],
      ["source_url", (l) => l.source_url],
      ["agent_profile_id", (l) => l.agent_profile_id],
    ];

    // A leading apostrophe on =,+,-,@ defuses spreadsheet formula injection -
    // exported lead text is attacker-controlled (a website visitor typed it).
    const escape = (value) => {
      if (value === null || value === undefined) return "";
      let text = String(value);
      if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
      return `"${text.replace(/"/g, '""')}"`;
    };

    const header = columns.map(([name]) => name).join(",");
    const rows = leads.map((lead) =>
      columns.map(([, accessor]) => escape(accessor(lead))).join(",")
    );
    return [header, ...rows].join("\n");
  },

  _validEmail: validEmail,
};

module.exports = { Lead };

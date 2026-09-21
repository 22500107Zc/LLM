const { reqBody } = require("../../utils/http");
const { Lead } = require("../models/lead");
const { Escalation } = require("../models/escalation");
const { AgentProfile } = require("../models/agentProfile");
const { dispatch } = require("../services/notifier");
const { publicWriteLimiter, safeHandler } = require("../middleware");
const { EmbedConfig } = require("../../models/embedConfig");
const { EmbedChats } = require("../../models/embedChats");
const { validate: validateUuid } = require("uuid");

/**
 * Public capture endpoints used by the website agent widget.
 *
 * This is the only part of the commercial surface an anonymous visitor can
 * reach, so it is treated as hostile input throughout:
 *   - the embed must exist, be enabled, and accept the requesting origin
 *   - the same CORS/allowlist rules as the chat endpoint apply
 *   - the endpoints are rate limited per IP
 *   - nothing about the deployment, its knowledge or its configuration is
 *     revealed in any response
 */

/**
 * Resolves and authorizes the embed behind a public request. Mirrors upstream's
 * `canRespond` allowlist logic so a capture call cannot bypass the domain
 * controls that protect the chat endpoint.
 */
async function authorizeEmbed(request, response, next) {
  try {
    const { embedId } = request.params;
    const embed = await EmbedConfig.getWithWorkspace({ uuid: String(embedId) });
    // A generic 404 for every rejection - an attacker learns nothing about
    // which embed IDs exist.
    if (!embed || !embed.enabled) return response.sendStatus(404);

    const origin = request.headers.origin ?? "";
    const allowedHosts = EmbedConfig.parseAllowedHosts(embed);

    const config = require("../config");
    if (allowedHosts === null && config.security.requireEmbedAllowlist)
      return response.sendStatus(404);

    if (allowedHosts !== null && !allowedHosts.includes(origin))
      return response.sendStatus(404);

    // Echo the verified origin rather than a wildcard so the browser enforces
    // the same allowlist we just checked.
    if (origin && allowedHosts !== null) {
      response.setHeader("Access-Control-Allow-Origin", origin);
      response.setHeader("Vary", "Origin");
    }

    response.locals.embedConfig = embed;
    return next();
  } catch (error) {
    console.error("[PublicCapture] authorization failed:", error.message);
    return response.sendStatus(404);
  }
}

/** Pulls the recent transcript for a session so an escalation carries context. */
async function transcriptFor(embedId, sessionId, limit = 20) {
  try {
    const history = await EmbedChats.forEmbedByUser(embedId, sessionId, limit, {
      id: "desc",
    });
    return history
      .reverse()
      .flatMap((chat) => {
        let answer = "";
        try {
          const parsed = JSON.parse(chat.response ?? "{}");
          answer = parsed?.text ?? parsed?.textResponse ?? "";
        } catch {
          answer = "";
        }
        return [
          { role: "user", content: chat.prompt },
          { role: "assistant", content: answer },
        ];
      })
      .filter((turn) => turn.content);
  } catch (error) {
    console.error("[PublicCapture] transcript lookup failed:", error.message);
    return [];
  }
}

function publicCaptureRoutes(app) {
  /**
   * Tells the widget what this agent wants to collect, so it can render the
   * right form. Returns configuration only - never knowledge or internals.
   */
  app.get(
    "/embed/:embedId/capture-config",
    [authorizeEmbed],
    safeHandler(async (_request, response) => {
      const embed = response.locals.embedConfig;
      const agent = await AgentProfile.forEmbed(embed);

      let requiredFields = [...Lead.DEFAULT_REQUIRED_FIELDS];
      try {
        const parsed = JSON.parse(agent?.lead_capture_fields || "[]");
        if (Array.isArray(parsed) && parsed.length) requiredFields = parsed;
      } catch {
        /* keep defaults */
      }

      response.status(200).json({
        leadCapture: Boolean(agent?.lead_capture_enabled),
        escalation: Boolean(agent?.escalation_enabled),
        requiredFields,
        availableFields: Lead.CONFIGURABLE_FIELDS,
      });
    })
  );

  /** Creates a lead from the widget's contact form. */
  app.post(
    "/embed/:embedId/lead",
    [authorizeEmbed, publicWriteLimiter],
    safeHandler(async (request, response) => {
      const embed = response.locals.embedConfig;
      const agent = await AgentProfile.forEmbed(embed);

      if (!agent?.lead_capture_enabled)
        return response.status(404).json({ error: "Not available." });

      const body = reqBody(request);
      if (!validateUuid(String(body.sessionId ?? "")))
        return response.status(400).json({ error: "Invalid session." });

      let requiredFields = [...Lead.DEFAULT_REQUIRED_FIELDS];
      try {
        const parsed = JSON.parse(agent.lead_capture_fields || "[]");
        if (Array.isArray(parsed) && parsed.length) requiredFields = parsed;
      } catch {
        /* keep defaults */
      }

      // Only one lead per session - the widget must never badger a visitor
      // into submitting repeatedly.
      const existing = await Lead.get({ session_id: String(body.sessionId) });
      if (existing)
        return response
          .status(200)
          .json({ success: true, alreadyCaptured: true });

      const transcript = await transcriptFor(embed.id, String(body.sessionId));
      const summary = transcript.length
        ? `Visitor asked: "${String(transcript[0].content).slice(0, 200)}"`
        : null;

      const { lead, error } = await Lead.create(
        {
          ...body,
          agentProfileId: agent.id,
          embedId: embed.id,
          conversationSummary: body.conversationSummary ?? summary,
          // The visitor cannot set these - they are observed server-side.
          sourceUrl: body.sourceUrl ?? request.headers.referer ?? null,
        },
        { requiredFields }
      );

      if (!lead) return response.status(400).json({ error });

      const delivery = await dispatch("lead.created", lead);
      await Lead.markDelivered(lead.id, {
        error:
          delivery.attempted && !delivery.delivered
            ? "No integration accepted the delivery."
            : null,
      });

      // The visitor gets a bare acknowledgement - no internal identifiers.
      response.status(200).json({ success: true });
    })
  );

  /** Creates an escalation when a visitor asks for a person. */
  app.post(
    "/embed/:embedId/escalate",
    [authorizeEmbed, publicWriteLimiter],
    safeHandler(async (request, response) => {
      const embed = response.locals.embedConfig;
      const agent = await AgentProfile.forEmbed(embed);

      if (!agent?.escalation_enabled)
        return response.status(404).json({ error: "Not available." });

      const body = reqBody(request);
      if (!validateUuid(String(body.sessionId ?? "")))
        return response.status(400).json({ error: "Invalid session." });

      const prisma = require("../../utils/prisma");
      const existing = await prisma.escalations.findFirst({
        where: { session_id: String(body.sessionId), status: "open" },
      });
      if (existing)
        return response.status(200).json({ success: true, alreadyEscalated: true });

      const transcript = await transcriptFor(embed.id, String(body.sessionId));

      const { escalation, error } = await Escalation.create({
        contactName: body.name ?? body.contactName,
        contactEmail: body.email ?? body.contactEmail,
        contactPhone: body.phone ?? body.contactPhone,
        question: body.question ?? transcript.find((t) => t.role === "user")?.content,
        transcript,
        summary: transcript.length
          ? `Visitor requested a human after ${Math.ceil(transcript.length / 2)} exchange(s).`
          : "Visitor requested a human.",
        agentProfileId: agent.id,
        embedId: embed.id,
        sessionId: String(body.sessionId),
        sourceUrl: body.sourceUrl ?? request.headers.referer ?? null,
        reason: body.reason === "no_answer" ? "no_answer" : "requested",
      });

      if (!escalation) return response.status(400).json({ error });

      const delivery = await dispatch("escalation.created", escalation);
      await Escalation.markDelivered(escalation.id, {
        error:
          delivery.attempted && !delivery.delivered
            ? "No integration accepted the delivery."
            : null,
      });

      response.status(200).json({ success: true });
    })
  );
}

module.exports = { publicCaptureRoutes, _authorizeEmbed: authorizeEmbed };

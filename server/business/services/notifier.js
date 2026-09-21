const crypto = require("crypto");
const config = require("../config");
const { Integration, PROVIDERS } = require("../models/integration");
const { postJSON, assertSafeDestination } = require("./outboundWebhook");

/**
 * Outbound notification dispatch.
 *
 * One dispatcher fans a business event out to every enabled integration that
 * subscribes to it. Every provider goes through the SSRF-guarded transport, and
 * a failing integration never breaks the action that produced the event.
 */

let transporter = null;
let transporterKey = null;

function smtpConfigured() {
  const smtp = config.notifications.smtp;
  return Boolean(smtp.host && smtp.from);
}

function mailer() {
  const smtp = config.notifications.smtp;
  if (!smtpConfigured()) return null;

  const key = JSON.stringify([smtp.host, smtp.port, smtp.secure, smtp.user]);
  if (transporter && transporterKey === key) return transporter;

  let nodemailer;
  try {
    nodemailer = require("nodemailer");
  } catch {
    console.error("[Notifier] nodemailer is not installed - email is disabled.");
    return null;
  }

  transporter = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    ...(smtp.user ? { auth: { user: smtp.user, pass: smtp.pass } } : {}),
  });
  transporterKey = key;
  return transporter;
}

/** Signs a webhook body so the receiver can verify it came from us. */
function signPayload(secret, timestamp, body) {
  return crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}.${body}`)
    .digest("hex");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Renders an event into a short human-readable summary for email/Slack. */
function describe(event, payload) {
  switch (event) {
    case "lead.created":
      return {
        title: "New lead captured",
        lines: [
          ["Name", [payload.first_name, payload.last_name].filter(Boolean).join(" ")],
          ["Email", payload.email],
          ["Company", payload.company],
          ["Phone", payload.phone],
          ["Job title", payload.job_title],
          ["Reason", payload.reason],
          ["Summary", payload.conversation_summary],
          ["Source", payload.source_url],
        ],
      };
    case "escalation.created":
      return {
        title: "Conversation escalated to a human",
        lines: [
          ["Contact", payload.contact_name],
          ["Email", payload.contact_email],
          ["Phone", payload.contact_phone],
          ["Reason", payload.reason],
          ["Question", payload.question],
          ["Summary", payload.summary],
          ["Source", payload.source_url],
        ],
      };
    case "knowledge_gap.detected":
      return {
        title: "Knowledge gap detected",
        lines: [
          ["Question", payload.question],
          ["Times asked", payload.frequency],
        ],
      };
    case "quality_run.completed":
      return {
        title: "AI quality run completed",
        lines: [
          ["Passed", payload.passed],
          ["Needs review", payload.needs_review],
          ["Failed", payload.failed],
        ],
      };
    case "billing.status_changed":
      return {
        title: "Billing status changed",
        lines: [
          ["Status", payload.status],
          ["Access", payload.access],
        ],
      };
    default:
      return { title: `Event: ${event}`, lines: [] };
  }
}

async function deliverWebhook(integration, event, payload) {
  const cfg = JSON.parse(integration.config || "{}");
  const secrets = Integration.secretsFor(integration);
  if (!cfg.url) return { ok: false, error: "No endpoint URL configured." };

  const body = {
    event,
    sentAt: new Date().toISOString(),
    source: config.branding.appName,
    deployment: config.customer.domain || config.branding.primaryDomain || null,
    data: payload,
  };

  const headers = {};
  if (secrets.signingSecret) {
    const timestamp = Math.floor(Date.now() / 1000);
    const serialized = JSON.stringify(body);
    headers["X-Platform-Timestamp"] = String(timestamp);
    headers["X-Platform-Signature"] = `sha256=${signPayload(
      secrets.signingSecret,
      timestamp,
      serialized
    )}`;
  }

  return postJSON(cfg.url, body, { headers });
}

async function deliverEmail(integration, event, payload) {
  const cfg = JSON.parse(integration.config || "{}");
  const to = cfg.to || config.notifications.leadNotificationEmail;
  if (!to) return { ok: false, error: "No recipient address configured." };

  const transport = mailer();
  if (!transport)
    return { ok: false, error: "SMTP is not configured on this deployment." };

  const { title, lines } = describe(event, payload);
  const prefix = cfg.subjectPrefix ? `${cfg.subjectPrefix} ` : "";
  const rows = lines
    .filter(([, value]) => value !== null && value !== undefined && value !== "")
    .map(
      ([label, value]) =>
        `<tr><td style="padding:4px 12px 4px 0;color:#666;vertical-align:top">${escapeHtml(
          label
        )}</td><td style="padding:4px 0">${escapeHtml(value)}</td></tr>`
    )
    .join("");

  try {
    await transport.sendMail({
      from: config.notifications.smtp.from,
      to,
      subject: `${prefix}${title} - ${config.branding.appName}`,
      text: lines
        .filter(([, value]) => value)
        .map(([label, value]) => `${label}: ${value}`)
        .join("\n"),
      html: `<div style="font-family:system-ui,sans-serif"><h2 style="margin:0 0 12px">${escapeHtml(
        title
      )}</h2><table style="border-collapse:collapse;font-size:14px">${rows}</table><p style="margin-top:20px;color:#888;font-size:12px">Sent by ${escapeHtml(
        config.branding.appName
      )}</p></div>`,
    });
    return { ok: true, status: 200 };
  } catch (error) {
    console.error("[Notifier] email delivery failed:", error.message);
    return { ok: false, error: "Email delivery failed." };
  }
}

async function deliverSlack(integration, event, payload) {
  const secrets = Integration.secretsFor(integration);
  if (!secrets.webhookUrl)
    return { ok: false, error: "No Slack webhook URL configured." };

  const { title, lines } = describe(event, payload);
  const text = [
    `*${title}* - ${config.branding.appName}`,
    ...lines
      .filter(([, value]) => value !== null && value !== undefined && value !== "")
      .map(([label, value]) => `• *${label}:* ${String(value).slice(0, 500)}`),
  ].join("\n");

  return postJSON(secrets.webhookUrl, { text });
}

async function deliverHubSpot(integration, event, payload) {
  if (event !== "lead.created")
    return { ok: true, status: 204, skipped: "HubSpot only receives leads." };

  const secrets = Integration.secretsFor(integration);
  if (!secrets.accessToken)
    return { ok: false, error: "No HubSpot access token configured." };
  if (!payload.email)
    return { ok: false, error: "HubSpot requires an email address on the lead." };

  const properties = {
    email: payload.email,
    ...(payload.first_name ? { firstname: payload.first_name } : {}),
    ...(payload.last_name ? { lastname: payload.last_name } : {}),
    ...(payload.company ? { company: payload.company } : {}),
    ...(payload.phone ? { phone: payload.phone } : {}),
    ...(payload.job_title ? { jobtitle: payload.job_title } : {}),
  };

  const result = await postJSON(
    "https://api.hubapi.com/crm/v3/objects/contacts",
    { properties },
    { headers: { Authorization: `Bearer ${secrets.accessToken}` } }
  );

  // A 409 means the contact already exists, which is a success for our purposes.
  if (!result.ok && result.status === 409)
    return { ok: true, status: 409, note: "Contact already exists in HubSpot." };
  return result;
}

async function deliverSalesforce(integration, event, payload) {
  if (event !== "lead.created")
    return { ok: true, status: 204, skipped: "Salesforce only receives leads." };

  const cfg = JSON.parse(integration.config || "{}");
  if (!cfg.oid) return { ok: false, error: "No Salesforce organization ID configured." };

  const endpoint =
    cfg.endpoint || "https://webto.salesforce.com/servlet/servlet.WebToLead?encoding=UTF-8";

  const check = await assertSafeDestination(endpoint);
  if (!check.ok) return { ok: false, error: check.reason };

  const form = new URLSearchParams({
    oid: cfg.oid,
    first_name: payload.first_name ?? "",
    last_name: payload.last_name ?? payload.first_name ?? "Unknown",
    email: payload.email ?? "",
    company: payload.company ?? "Unknown",
    phone: payload.phone ?? "",
    title: payload.job_title ?? "",
    description: [payload.reason, payload.conversation_summary]
      .filter(Boolean)
      .join("\n\n")
      .slice(0, 32_000),
    lead_source: config.branding.appName,
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(check.url.toString(), {
      method: "POST",
      redirect: "manual",
      signal: controller.signal,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    // Web-to-Lead answers 200/302 on acceptance and never returns a body.
    const accepted = response.status === 200 || response.status === 302;
    return {
      ok: accepted,
      status: response.status,
      error: accepted ? null : `Salesforce responded with ${response.status}.`,
    };
  } catch (error) {
    return {
      ok: false,
      error: error?.name === "AbortError" ? "Salesforce timed out." : "Salesforce request failed.",
    };
  } finally {
    clearTimeout(timeout);
  }
}

const DELIVERERS = {
  [PROVIDERS.WEBHOOK]: deliverWebhook,
  [PROVIDERS.EMAIL]: deliverEmail,
  [PROVIDERS.SLACK]: deliverSlack,
  [PROVIDERS.HUBSPOT]: deliverHubSpot,
  [PROVIDERS.SALESFORCE]: deliverSalesforce,
};

/**
 * Fans a business event out to every subscribed integration.
 * Always resolves - delivery problems are logged, never thrown.
 * @param {string} event one of Integration.EVENTS
 * @param {object} payload the serialized business record
 * @returns {Promise<{attempted: number, delivered: number, results: object[]}>}
 */
async function dispatch(event, payload) {
  const results = [];
  let delivered = 0;

  try {
    const integrations = await Integration.where({ enabled: true });
    const subscribed = integrations.filter((integration) => {
      try {
        const events = JSON.parse(integration.events || "[]");
        return Array.isArray(events) && events.includes(event);
      } catch {
        return false;
      }
    });

    for (const integration of subscribed) {
      const deliver = DELIVERERS[integration.provider];
      if (!deliver) continue;

      let result;
      try {
        result = await deliver(integration, event, payload);
      } catch (error) {
        console.error(
          `[Notifier] ${integration.provider} threw during delivery:`,
          error.message
        );
        result = { ok: false, error: "Delivery failed unexpectedly." };
      }

      if (result.ok) delivered += 1;
      await Integration.recordDelivery({
        integrationId: integration.id,
        event,
        status: result.ok ? "success" : "failed",
        statusCode: result.status ?? null,
        error: result.error ?? null,
      });

      results.push({
        integration: integration.uuid,
        provider: integration.provider,
        ok: result.ok,
        error: result.error ?? null,
      });
    }

    return { attempted: subscribed.length, delivered, results };
  } catch (error) {
    console.error("[Notifier] dispatch failed:", error.message);
    return { attempted: 0, delivered: 0, results: [] };
  }
}

/** Sends a test payload through a single integration. */
async function test(integrationUuid) {
  const integration = await Integration.get({ uuid: String(integrationUuid) });
  if (!integration) return { ok: false, error: "Integration not found." };

  const deliver = DELIVERERS[integration.provider];
  if (!deliver) return { ok: false, error: "Unsupported provider." };

  const samplePayload = {
    first_name: "Test",
    last_name: "Contact",
    email: "test.contact@example.com",
    company: "Example Co",
    reason: "This is a test delivery from your AI platform.",
    conversation_summary: "Test delivery - no real visitor was involved.",
    source_url: config.deployment.publicUrl || null,
    test: true,
  };

  let result;
  try {
    result = await deliver(integration, "lead.created", samplePayload);
  } catch (error) {
    result = { ok: false, error: "Delivery failed unexpectedly." };
  }

  await Integration.recordDelivery({
    integrationId: integration.id,
    event: "test",
    status: result.ok ? "success" : "failed",
    statusCode: result.status ?? null,
    error: result.error ?? null,
  });

  return result;
}

module.exports = {
  dispatch,
  test,
  smtpConfigured,
  signPayload,
  _describe: describe,
};

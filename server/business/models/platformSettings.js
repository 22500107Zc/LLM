const prisma = require("../../utils/prisma");
const config = require("../config");
const { AuditLog } = require("./audit");

/**
 * Deployment-level settings that a business edits from the UI, as opposed to
 * the environment variables an operator sets at provisioning time.
 *
 * Environment values remain the source of truth for anything security- or
 * billing-relevant; these are presentation and workflow settings.
 */

const KEYS = Object.freeze({
  COMPANY_NAME: "company_name",
  COMPANY_WEBSITE: "company_website",
  COMPANY_INDUSTRY: "company_industry",
  COMPANY_DESCRIPTION: "company_description",
  SUPPORT_EMAIL: "support_email",
  ESCALATION_EMAIL: "escalation_email",
  LEAD_NOTIFICATION_EMAIL: "lead_notification_email",
  ONBOARDING_STATE: "onboarding_state",
  ONBOARDING_COMPLETED: "onboarding_completed",
  GO_LIVE_AT: "go_live_at",
  LAST_BACKUP_AT: "last_backup_at",
});

/** The guided first-run experience, in business language. */
const ONBOARDING_STEPS = Object.freeze([
  {
    key: "company",
    title: "Company information",
    description:
      "Tell us who you are so the platform can speak for your business.",
  },
  {
    key: "owner",
    title: "Owner account",
    description: "Confirm who owns this platform and holds full access.",
  },
  {
    key: "provider",
    title: "Connect your AI provider",
    description:
      "Add your own AI provider credentials so your data stays under your contract.",
  },
  {
    key: "knowledge",
    title: "Upload company knowledge",
    description: "Add the documents your AI should answer from.",
  },
  {
    key: "first_agent",
    title: "Create your first AI agent",
    description:
      "Pick a starting point such as Customer Support or Internal Knowledge.",
  },
  {
    key: "test_agent",
    title: "Test your agent",
    description: "Ask it a real question and confirm the answer is right.",
  },
  {
    key: "website_agent",
    title: "Create your website agent",
    description: "Put your AI on your website with a copy-and-paste snippet.",
  },
  {
    key: "lead_capture",
    title: "Configure lead capture",
    description: "Decide what details to collect when a visitor is interested.",
  },
  {
    key: "escalation",
    title: "Configure human escalation",
    description: "Choose where conversations go when someone needs a person.",
  },
  {
    key: "team",
    title: "Invite your team",
    description: "Give colleagues the access level they need.",
  },
  {
    key: "billing",
    title: "Confirm billing",
    description:
      "Check your subscription is active and your invoices are reaching you.",
  },
  {
    key: "go_live",
    title: "Go live",
    description:
      "Enable your website agent and start answering real questions.",
  },
]);

const PlatformSettings = {
  KEYS,
  ONBOARDING_STEPS,

  get: async function (label, fallback = null) {
    try {
      const row = await prisma.platform_settings.findUnique({
        where: { label: String(label) },
      });
      return row?.value ?? fallback;
    } catch (error) {
      console.error("[PlatformSettings] read failed:", error.message);
      return fallback;
    }
  },

  getJSON: async function (label, fallback = {}) {
    const raw = await this.get(label);
    if (!raw) return fallback;
    try {
      return JSON.parse(raw);
    } catch {
      return fallback;
    }
  },

  set: async function (label, value, { actor = null, audit = true } = {}) {
    try {
      const serialized =
        value === null || value === undefined
          ? null
          : typeof value === "string"
            ? value
            : JSON.stringify(value);

      await prisma.platform_settings.upsert({
        where: { label: String(label) },
        update: { value: serialized, lastUpdatedAt: new Date() },
        create: { label: String(label), value: serialized },
      });

      if (audit)
        await AuditLog.log({
          action: "settings.updated",
          category: AuditLog.CATEGORIES.SETTINGS,
          actor,
          resource: "platform_setting",
          resourceId: label,
        });
      return true;
    } catch (error) {
      console.error("[PlatformSettings] write failed:", error.message);
      return false;
    }
  },

  /** The company profile, falling back to deployment environment values. */
  companyProfile: async function () {
    const [name, website, industry, description, supportEmail] =
      await Promise.all([
        this.get(KEYS.COMPANY_NAME),
        this.get(KEYS.COMPANY_WEBSITE),
        this.get(KEYS.COMPANY_INDUSTRY),
        this.get(KEYS.COMPANY_DESCRIPTION),
        this.get(KEYS.SUPPORT_EMAIL),
      ]);

    return {
      name: name || config.customer.name || config.branding.companyName,
      website: website || config.customer.domain || "",
      industry: industry || "",
      description: description || "",
      supportEmail: supportEmail || config.branding.supportEmail || "",
    };
  },

  /**
   * Computes onboarding progress. Most steps are detected from real state
   * rather than a checkbox, so the checklist reflects the deployment's truth.
   */
  onboardingState: async function () {
    const manual = await this.getJSON(KEYS.ONBOARDING_STATE, {});
    const { Billing } = require("./billing");
    const { Team } = require("./team");

    const [
      profile,
      agentCount,
      publicAgentCount,
      documentCount,
      userCount,
      embedCount,
      integrationCount,
      billingRecord,
      owner,
    ] = await Promise.all([
      this.companyProfile(),
      prisma.agent_profiles.count(),
      prisma.agent_profiles.count({ where: { visibility: "public" } }),
      prisma.workspace_documents.count(),
      prisma.users.count(),
      prisma.embed_configs.count({ where: { enabled: true } }),
      prisma.integrations.count({ where: { enabled: true } }),
      Billing.get(),
      Team.owner(),
    ]);

    const providerConfigured = Boolean(
      process.env.LLM_PROVIDER &&
        // A provider is only really connected once a credential exists for it.
        Object.keys(process.env).some(
          (key) => /_API_KEY$|_ACCESS_KEY$|_KEY$/.test(key) && process.env[key]
        )
    );

    const chatCount = await prisma.workspace_chats.count();

    const detected = {
      company: Boolean(profile.name && profile.website),
      owner: Boolean(owner),
      provider: providerConfigured,
      knowledge: documentCount > 0,
      first_agent: agentCount > 0,
      test_agent: chatCount > 0,
      website_agent: publicAgentCount > 0 && embedCount > 0,
      lead_capture: manual.lead_capture === true || integrationCount > 0,
      escalation: manual.escalation === true || integrationCount > 0,
      team: userCount > 1,
      billing: Boolean(billingRecord?.stripe_subscription_id),
      go_live: manual.go_live === true,
    };

    const steps = ONBOARDING_STEPS.map((step) => ({
      ...step,
      complete: Boolean(detected[step.key] ?? manual[step.key]),
      // Steps that cannot be auto-detected can be ticked off by the operator.
      manual: ["lead_capture", "escalation", "go_live"].includes(step.key),
    }));

    const completed = steps.filter((step) => step.complete).length;

    return {
      steps,
      completed,
      total: steps.length,
      percent: Math.round((completed / steps.length) * 100),
      finished: completed === steps.length,
    };
  },

  markOnboardingStep: async function ({ step, complete = true, actor = null }) {
    const valid = ONBOARDING_STEPS.some((s) => s.key === step);
    if (!valid) return { success: false, error: "Unknown onboarding step." };

    const state = await this.getJSON(KEYS.ONBOARDING_STATE, {});
    state[step] = Boolean(complete);
    await this.set(KEYS.ONBOARDING_STATE, state, { actor, audit: false });

    if (step === "go_live" && complete)
      await this.set(KEYS.GO_LIVE_AT, new Date().toISOString(), {
        audit: false,
      });

    await AuditLog.log({
      action: "onboarding.step_updated",
      category: AuditLog.CATEGORIES.SETTINGS,
      actor,
      resource: "onboarding",
      resourceId: step,
      metadata: { complete: Boolean(complete) },
    });

    return { success: true, state: await this.onboardingState() };
  },
};

module.exports = { PlatformSettings, ONBOARDING_STEPS };

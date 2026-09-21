const crypto = require("crypto");
const { v4: uuidv4 } = require("uuid");
const prisma = require("../../utils/prisma");
const config = require("../config");
const { AuditLog } = require("./audit");

/**
 * Realized-value evidence.
 *
 * The commercial claim is a multiple of the monthly fee. That claim is only
 * worth making if the underlying numbers are real, so this module is built to
 * refuse anything softer than evidence:
 *
 *   - A captured lead is NOT revenue. Revenue counts only as realized gross
 *     profit, once a conversion and a profit amount are confirmed.
 *   - An avoided cost counts only when a customer-approved baseline AND a
 *     measured post-deployment figure both exist.
 *   - Nothing counts toward the qualification verdict until a human has
 *     verified it against a named piece of evidence.
 *   - A one-time recovery never inflates the recurring monthly figure.
 *   - The same underlying event cannot be counted twice.
 */

const KINDS = Object.freeze({
  REALIZED_GROSS_PROFIT: "realized_gross_profit",
  AVOIDED_COST: "avoided_cost",
});

const VERIFICATION = Object.freeze({
  PENDING: "pending",
  VERIFIED: "verified",
  REJECTED: "rejected",
});

/**
 * Categories a value record may be filed under. Each names a business outcome,
 * never an activity metric - "a lead was captured" is an activity, not value.
 */
const CATEGORIES = Object.freeze({
  closed_won_revenue: {
    label: "Closed-won gross profit",
    kind: KINDS.REALIZED_GROSS_PROFIT,
    help: "Gross profit on a deal that closed and was attributed to the platform. Not pipeline, not a lead.",
  },
  retained_revenue: {
    label: "Retained gross profit",
    kind: KINDS.REALIZED_GROSS_PROFIT,
    help: "Gross profit on a renewal or save that would otherwise have churned.",
  },
  support_deflection: {
    label: "Support cost avoided",
    kind: KINDS.AVOIDED_COST,
    help: "Requires an approved pre-deployment cost baseline and a measured figure afterwards.",
  },
  staff_time_avoided: {
    label: "Staff time avoided",
    kind: KINDS.AVOIDED_COST,
    help: "Hours no longer spent, costed at an agreed rate. Requires an approved baseline.",
  },
  vendor_cost_avoided: {
    label: "Vendor cost avoided",
    kind: KINDS.AVOIDED_COST,
    help: "A tool or service retired because of the platform. Requires the prior contract as evidence.",
  },
});

/** Multiples the commercial narrative is measured against. */
const THRESHOLDS = Object.freeze({ QUALIFIED_90X: 90, QUALIFIED_100X: 100 });

const PERIOD_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

function currentPeriod(now = new Date()) {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * A stable key for the underlying business event, so the same closed deal
 * submitted twice (or synced twice from a CRM) is rejected rather than
 * doubling the total.
 */
function dedupeKeyFor({ category, period, sourceSystem, sourceReference, evidenceRef, amountCents }) {
  const basis = [
    String(category ?? ""),
    String(period ?? ""),
    String(sourceSystem ?? "manual").toLowerCase(),
    // The source reference is the real identity when present; otherwise fall
    // back to the evidence reference and amount so obvious repeats collide.
    String(sourceReference ?? evidenceRef ?? `amount:${amountCents}`).toLowerCase(),
  ].join("|");
  return crypto.createHash("sha256").update(basis).digest("hex");
}

function toCents(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.round(number);
}

const ValueRecords = {
  KINDS,
  VERIFICATION,
  CATEGORIES,
  THRESHOLDS,
  currentPeriod,
  dedupeKeyFor,

  /** The monthly fee this deployment is measured against, in cents. */
  monthlyFeeCents() {
    return config.PLAN.amountCents;
  },

  /**
   * Creates a value record. Always starts unverified: creating a record never
   * moves the qualification verdict on its own.
   */
  create: async function (input = {}, { actor = null } = {}) {
    const category = String(input.category ?? "");
    const spec = CATEGORIES[category];
    if (!spec) return { record: null, error: "Unknown value category." };

    const period = String(input.period ?? currentPeriod());
    if (!PERIOD_PATTERN.test(period))
      return { record: null, error: "Period must be a month in YYYY-MM form." };

    const amountCents = toCents(input.amountCents);
    if (amountCents === null || amountCents <= 0)
      return { record: null, error: "Amount must be a positive number of cents." };

    // An avoided cost is meaningless without both sides of the comparison.
    const baselineCents = toCents(input.baselineCents);
    const measuredCents = toCents(input.measuredCents);
    if (spec.kind === KINDS.AVOIDED_COST) {
      if (baselineCents === null || measuredCents === null)
        return {
          record: null,
          error:
            "An avoided cost needs both a customer-approved baseline and a measured figure.",
        };
      if (!input.baselineApprovedBy)
        return {
          record: null,
          error: "Record who approved the baseline before claiming an avoided cost.",
        };
      if (measuredCents >= baselineCents)
        return {
          record: null,
          error: "The measured figure is not lower than the baseline, so no cost was avoided.",
        };
      const difference = baselineCents - measuredCents;
      if (amountCents > difference)
        return {
          record: null,
          error: `The claimed amount exceeds the measured saving of ${difference} cents.`,
        };
    }

    const recurring = input.recurring !== false;
    const dedupeKey = dedupeKeyFor({
      category,
      period,
      sourceSystem: input.sourceSystem,
      sourceReference: input.sourceReference,
      evidenceRef: input.evidenceRef,
      amountCents,
    });

    try {
      const existing = await prisma.value_records.findUnique({ where: { dedupe_key: dedupeKey } });
      if (existing)
        return {
          record: null,
          error:
            "This looks like the same underlying event as an existing record, so it was not counted twice.",
          duplicateOf: existing.uuid,
        };

      const record = await prisma.value_records.create({
        data: {
          uuid: uuidv4(),
          category,
          kind: spec.kind,
          period,
          amount_cents: amountCents,
          currency: String(input.currency ?? "usd").toLowerCase(),
          recurring,
          verification: VERIFICATION.PENDING,
          description: input.description ? String(input.description).slice(0, 1_000) : null,
          evidence_ref: input.evidenceRef ? String(input.evidenceRef).slice(0, 300) : null,
          evidence_note: input.evidenceNote ? String(input.evidenceNote).slice(0, 2_000) : null,
          source_system: input.sourceSystem ? String(input.sourceSystem).slice(0, 120) : null,
          source_reference: input.sourceReference
            ? String(input.sourceReference).slice(0, 300)
            : null,
          dedupe_key: dedupeKey,
          baseline_cents: baselineCents,
          measured_cents: measuredCents,
          baseline_approved_by: input.baselineApprovedBy
            ? String(input.baselineApprovedBy).slice(0, 200)
            : null,
          createdBy: actor?.id ? Number(actor.id) : null,
        },
      });

      await this.recordEvent(record.id, "created", actor, `${category} ${amountCents} cents`);
      await AuditLog.log({
        action: "value.record_created",
        category: AuditLog.CATEGORIES.SETTINGS,
        actor,
        resource: "value_record",
        resourceId: record.uuid,
        metadata: { category, period, amountCents, recurring },
      });

      return { record, error: null };
    } catch (error) {
      if (error?.code === "P2002")
        return { record: null, error: "This event has already been recorded." };
      console.error("[Value] create failed:", error.message);
      return { record: null, error: "Unable to record the value entry." };
    }
  },

  /**
   * Verifies or rejects a record. Verification is the only thing that makes a
   * number count, and it is deliberately a separate, audited action.
   */
  setVerification: async function ({ uuid, verification, note = null, actor = null }) {
    if (!Object.values(VERIFICATION).includes(verification))
      return { success: false, error: "Unknown verification state." };

    try {
      const existing = await prisma.value_records.findUnique({ where: { uuid: String(uuid) } });
      if (!existing) return { success: false, error: "Value record not found." };

      if (verification === VERIFICATION.VERIFIED) {
        if (!existing.evidence_ref)
          return {
            success: false,
            error: "A record cannot be verified without an evidence reference.",
          };
        // Self-verification defeats the purpose of a verification step.
        if (existing.createdBy && actor?.id && Number(existing.createdBy) === Number(actor.id))
          return {
            success: false,
            error:
              "A value record must be verified by someone other than the person who created it.",
          };
      }

      const record = await prisma.value_records.update({
        where: { uuid: String(uuid) },
        data: {
          verification,
          verifiedBy: verification === VERIFICATION.VERIFIED ? (actor?.id ?? null) : null,
          verifiedAt: verification === VERIFICATION.VERIFIED ? new Date() : null,
          lastUpdatedAt: new Date(),
        },
      });

      await this.recordEvent(record.id, `verification:${verification}`, actor, note);
      await AuditLog.log({
        action: "value.verification_changed",
        category: AuditLog.CATEGORIES.SETTINGS,
        actor,
        resource: "value_record",
        resourceId: uuid,
        metadata: { from: existing.verification, to: verification },
      });

      return { success: true, record };
    } catch (error) {
      console.error("[Value] verification failed:", error.message);
      return { success: false, error: "Unable to update the verification state." };
    }
  },

  recordEvent: async function (valueRecordId, action, actor, detail) {
    try {
      await prisma.value_record_events.create({
        data: {
          value_record_id: Number(valueRecordId),
          action: String(action).slice(0, 80),
          actor_id: actor?.id ? Number(actor.id) : null,
          actor_label: actor?.username ? String(actor.username).slice(0, 120) : null,
          detail: detail ? String(detail).slice(0, 1_000) : null,
        },
      });
    } catch (error) {
      console.error("[Value] history write failed:", error.message);
    }
  },

  history: async function (uuid) {
    try {
      const record = await prisma.value_records.findUnique({ where: { uuid: String(uuid) } });
      if (!record) return [];
      return await prisma.value_record_events.findMany({
        where: { value_record_id: record.id },
        orderBy: { id: "asc" },
      });
    } catch {
      return [];
    }
  },

  where: async function (clause = {}, limit = 500) {
    try {
      return await prisma.value_records.findMany({
        where: clause,
        take: Math.min(Number(limit) || 500, 1_000),
        orderBy: [{ period: "desc" }, { id: "desc" }],
      });
    } catch (error) {
      console.error(error.message);
      return [];
    }
  },

  delete: async function ({ uuid, actor = null }) {
    try {
      const existing = await prisma.value_records.findUnique({ where: { uuid: String(uuid) } });
      if (!existing) return { success: false, error: "Value record not found." };
      await prisma.value_record_events.deleteMany({ where: { value_record_id: existing.id } });
      await prisma.value_records.delete({ where: { uuid: String(uuid) } });
      await AuditLog.log({
        action: "value.record_removed",
        category: AuditLog.CATEGORIES.SETTINGS,
        actor,
        resource: "value_record",
        resourceId: uuid,
        metadata: { category: existing.category, amountCents: existing.amount_cents },
      });
      return { success: true };
    } catch (error) {
      console.error("[Value] delete failed:", error.message);
      return { success: false, error: "Unable to remove the value record." };
    }
  },

  /**
   * The qualification summary for a month.
   *
   * Verified recurring value is the ONLY figure the verdict uses. Pending
   * records and one-time recoveries are reported separately so nobody mistakes
   * a hopeful total for an evidenced one.
   */
  summary: async function (period = currentPeriod()) {
    const feeCents = this.monthlyFeeCents();
    const records = await this.where({ period: String(period) });

    const verified = records.filter((r) => r.verification === VERIFICATION.VERIFIED);
    const pending = records.filter((r) => r.verification === VERIFICATION.PENDING);

    const sum = (rows) => rows.reduce((total, row) => total + (row.amount_cents ?? 0), 0);

    // A one-time recovery is real value but it does not recur, so it must not
    // inflate a monthly multiple.
    const verifiedRecurring = verified.filter((r) => r.recurring);
    const verifiedOneTime = verified.filter((r) => !r.recurring);

    const recurringCents = sum(verifiedRecurring);
    const oneTimeCents = sum(verifiedOneTime);
    const pendingCents = sum(pending);

    const multiple = feeCents > 0 ? recurringCents / feeCents : 0;
    const netRoi = feeCents > 0 ? (recurringCents - feeCents) / feeCents : 0;

    let status = "below_90x";
    if (multiple >= THRESHOLDS.QUALIFIED_100X) status = "qualified_100x";
    else if (multiple >= THRESHOLDS.QUALIFIED_90X) status = "qualified_90x";

    return {
      period: String(period),
      fee: {
        monthlyCents: feeCents,
        display: config.PLAN.displayPriceWithInterval,
      },
      thresholds: {
        x90: { multiple: THRESHOLDS.QUALIFIED_90X, requiredCents: feeCents * THRESHOLDS.QUALIFIED_90X },
        x100: { multiple: THRESHOLDS.QUALIFIED_100X, requiredCents: feeCents * THRESHOLDS.QUALIFIED_100X },
      },
      verified: {
        recurringCents,
        oneTimeCents,
        recordCount: verified.length,
      },
      // Reported, never counted.
      unverified: { pendingCents, recordCount: pending.length },
      multiple: Math.round(multiple * 100) / 100,
      netRoi: Math.round(netRoi * 100) / 100,
      status,
      // The UI must never say "qualified" on the strength of pending records.
      qualifiedOnVerifiedEvidenceOnly: true,
      shortfall: {
        to90xCents: Math.max(0, feeCents * THRESHOLDS.QUALIFIED_90X - recurringCents),
        to100xCents: Math.max(0, feeCents * THRESHOLDS.QUALIFIED_100X - recurringCents),
      },
      byCategory: Object.fromEntries(
        Object.keys(CATEGORIES).map((key) => [
          key,
          sum(verifiedRecurring.filter((r) => r.category === key)),
        ])
      ),
    };
  },

  /**
   * Prospect calculator: what a business would have to achieve for the fee to
   * return 90x or 100x. These are ASSUMPTIONS, never results, and the API
   * labels them that way.
   */
  qualificationScenarios({ grossProfitPerSaleCents = null, monthlyCostBaseCents = null } = {}) {
    const feeCents = this.monthlyFeeCents();
    const scenarios = {};

    if (grossProfitPerSaleCents && grossProfitPerSaleCents > 0) {
      scenarios.additionalSales = {
        assumptionCents: grossProfitPerSaleCents,
        for90x: Math.ceil((feeCents * THRESHOLDS.QUALIFIED_90X) / grossProfitPerSaleCents),
        for100x: Math.ceil((feeCents * THRESHOLDS.QUALIFIED_100X) / grossProfitPerSaleCents),
      };
    }

    if (monthlyCostBaseCents && monthlyCostBaseCents > 0) {
      scenarios.costReduction = {
        assumptionCents: monthlyCostBaseCents,
        // Expressed as a percentage of the stated cost base.
        percentFor90x:
          Math.round(((feeCents * THRESHOLDS.QUALIFIED_90X) / monthlyCostBaseCents) * 1000) / 10,
        percentFor100x:
          Math.round(((feeCents * THRESHOLDS.QUALIFIED_100X) / monthlyCostBaseCents) * 1000) / 10,
      };
    }

    return {
      feeCents,
      requiredCents: {
        x90: feeCents * THRESHOLDS.QUALIFIED_90X,
        x100: feeCents * THRESHOLDS.QUALIFIED_100X,
      },
      scenarios,
      isAssumption: true,
      note: "These are assumptions for discussion, not measured results. Only verified records on the Value page count toward qualification.",
    };
  },

  /** CSV export, with the same spreadsheet-injection defence used elsewhere. */
  toCSV(records = []) {
    const escape = (value) => {
      if (value === null || value === undefined) return "";
      let text = String(value);
      if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
      return `"${text.replace(/"/g, '""')}"`;
    };
    const header = [
      "period",
      "category",
      "kind",
      "amount_cents",
      "currency",
      "recurring",
      "verification",
      "evidence_ref",
      "source_system",
      "source_reference",
      "baseline_cents",
      "measured_cents",
      "baseline_approved_by",
      "verified_at",
      "description",
    ].join(",");
    const rows = records.map((r) =>
      [
        r.period,
        r.category,
        r.kind,
        r.amount_cents,
        r.currency,
        r.recurring,
        r.verification,
        r.evidence_ref,
        r.source_system,
        r.source_reference,
        r.baseline_cents,
        r.measured_cents,
        r.baseline_approved_by,
        r.verifiedAt ? new Date(r.verifiedAt).toISOString() : "",
        r.description,
      ]
        .map(escape)
        .join(",")
    );
    return [header, ...rows].join("\n");
  },
};

module.exports = { ValueRecords, KINDS, VERIFICATION, CATEGORIES, THRESHOLDS };

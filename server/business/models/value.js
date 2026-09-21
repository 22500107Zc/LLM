const crypto = require("crypto");
const { v4: uuidv4 } = require("uuid");
const prisma = require("../../utils/prisma");
const config = require("../config");
const { AuditLog } = require("./audit");

/**
 * Realized-value evidence and return on subscription.
 *
 * The number this page reports is the customer's own return, and it changes as
 * their inputs change. There is no target to reach and no verdict to pass:
 *
 *   - Monthly benefit = eligible recurring cost savings + attributable
 *     incremental gross profit, for the selected month.
 *   - Return multiple = monthly benefit / subscription fee for that month.
 *   - Net value after subscription = monthly benefit - subscription fee.
 *
 * What is still enforced is honesty about the inputs:
 *
 *   - A captured lead is NOT revenue. Revenue counts only as realized gross
 *     profit, once a conversion and a profit amount are confirmed.
 *   - An avoided cost counts only when a customer-approved baseline AND a
 *     measured post-deployment figure both exist.
 *   - Time valued at a rate is reported apart from an actual reduction in cash
 *     spending, because they are not the same kind of money.
 *   - A one-time recovery never inflates the recurring monthly figure, and
 *     never repeats into a later month.
 *   - Rejected records are excluded. The same underlying event cannot be
 *     counted twice.
 *
 * A record counts toward the headline as soon as it is recorded, so a customer
 * sees the effect of their own input immediately. The verified portion stays
 * separately identifiable, and the headline says so when it includes estimates.
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
 * How a benefit shows up in the business. A cost that stops being paid is cash
 * that stays in the account; hours no longer spent are real but are valued at
 * an agreed rate rather than observed leaving the bank, so the two are
 * reported separately and never silently merged.
 */
const BASIS = Object.freeze({
  GROSS_PROFIT: "gross_profit",
  CASH_SAVING: "cash_saving",
  TIME_VALUED: "time_valued",
});

/**
 * Categories a value record may be filed under. Each names a business outcome,
 * never an activity metric - "a lead was captured" is an activity, not value.
 */
const CATEGORIES = Object.freeze({
  closed_won_revenue: {
    label: "Closed-won gross profit",
    kind: KINDS.REALIZED_GROSS_PROFIT,
    basis: BASIS.GROSS_PROFIT,
    help: "Gross profit on a deal that closed and was attributed to the platform. Not pipeline, not a lead.",
  },
  retained_revenue: {
    label: "Retained gross profit",
    kind: KINDS.REALIZED_GROSS_PROFIT,
    basis: BASIS.GROSS_PROFIT,
    help: "Gross profit on a renewal or save that would otherwise have churned.",
  },
  support_deflection: {
    label: "Support cost avoided",
    kind: KINDS.AVOIDED_COST,
    basis: BASIS.CASH_SAVING,
    help: "Requires an approved pre-deployment cost baseline and a measured figure afterwards.",
  },
  staff_time_avoided: {
    label: "Staff time avoided",
    kind: KINDS.AVOIDED_COST,
    basis: BASIS.TIME_VALUED,
    help: "Hours no longer spent, costed at an agreed rate. Requires an approved baseline. Reported apart from cash savings.",
  },
  vendor_cost_avoided: {
    label: "Vendor cost avoided",
    kind: KINDS.AVOIDED_COST,
    basis: BASIS.CASH_SAVING,
    help: "A tool or service retired because of the platform. Requires the prior contract as evidence.",
  },
});

const PERIOD_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

function currentPeriod(now = new Date()) {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * A stable key for the underlying business event, so the same closed deal
 * submitted twice (or synced twice from a CRM) is rejected rather than
 * doubling the total.
 */
function dedupeKeyFor({
  category,
  period,
  sourceSystem,
  sourceReference,
  evidenceRef,
  amountCents,
}) {
  const basis = [
    String(category ?? ""),
    String(period ?? ""),
    String(sourceSystem ?? "manual").toLowerCase(),
    // The source reference is the real identity when present; otherwise fall
    // back to the evidence reference and amount so obvious repeats collide.
    String(
      sourceReference ?? evidenceRef ?? `amount:${amountCents}`
    ).toLowerCase(),
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
  BASIS,
  currentPeriod,
  dedupeKeyFor,

  /** The configured subscription fee, in cents. Never hardcoded here. */
  monthlyFeeCents() {
    const cents = Number(config.PLAN.amountCents);
    return Number.isFinite(cents) && cents > 0 ? Math.round(cents) : 0;
  },

  /**
   * The subscription fee to measure a given month against.
   *
   * Only the current configured fee is knowable; this deployment keeps no
   * per-month billed history. For any earlier month that fee is an assumption,
   * and it is returned labelled as one rather than presented as the amount
   * that was actually billed.
   */
  feeForPeriod(period = currentPeriod()) {
    const monthlyCents = this.monthlyFeeCents();
    const isCurrent = String(period) === currentPeriod();
    return {
      monthlyCents,
      currency: String(config.PLAN.currency ?? "usd").toLowerCase(),
      display: config.PLAN.displayPriceWithInterval,
      available: monthlyCents > 0,
      source: "configured",
      isAssumption: !isCurrent && monthlyCents > 0,
      note: !isCurrent
        ? "Measured against the currently configured subscription fee. This deployment keeps no record of what was billed in an earlier month, so for past months this fee is an assumption, not the historical amount."
        : null,
    };
  },

  /**
   * Creates a value record.
   *
   * It starts unverified but counts toward the displayed return straight
   * away, clearly labelled as an estimate, so the customer sees the effect of
   * their own input without waiting for a second person.
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
      return {
        record: null,
        error: "Amount must be a positive number of cents.",
      };

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
          error:
            "Record who approved the baseline before claiming an avoided cost.",
        };
      if (measuredCents >= baselineCents)
        return {
          record: null,
          error:
            "The measured figure is not lower than the baseline, so no cost was avoided.",
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
      const existing = await prisma.value_records.findUnique({
        where: { dedupe_key: dedupeKey },
      });
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
          description: input.description
            ? String(input.description).slice(0, 1_000)
            : null,
          evidence_ref: input.evidenceRef
            ? String(input.evidenceRef).slice(0, 300)
            : null,
          evidence_note: input.evidenceNote
            ? String(input.evidenceNote).slice(0, 2_000)
            : null,
          source_system: input.sourceSystem
            ? String(input.sourceSystem).slice(0, 120)
            : null,
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

      await this.recordEvent(
        record.id,
        "created",
        actor,
        `${category} ${amountCents} cents`
      );
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
   * Verifies or rejects a record.
   *
   * Verification no longer decides whether a number counts - it decides which
   * portion of the total is evidenced. A rejected record drops out of the
   * total entirely. Either way the record moves between portions; it is never
   * counted in two of them at once.
   */
  setVerification: async function ({
    uuid,
    verification,
    note = null,
    actor = null,
  }) {
    if (!Object.values(VERIFICATION).includes(verification))
      return { success: false, error: "Unknown verification state." };

    try {
      const existing = await prisma.value_records.findUnique({
        where: { uuid: String(uuid) },
      });
      if (!existing)
        return { success: false, error: "Value record not found." };

      if (verification === VERIFICATION.VERIFIED) {
        if (!existing.evidence_ref)
          return {
            success: false,
            error: "A record cannot be verified without an evidence reference.",
          };
        // Self-verification defeats the purpose of a verification step.
        if (
          existing.createdBy &&
          actor?.id &&
          Number(existing.createdBy) === Number(actor.id)
        )
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
          verifiedBy:
            verification === VERIFICATION.VERIFIED ? actor?.id ?? null : null,
          verifiedAt:
            verification === VERIFICATION.VERIFIED ? new Date() : null,
          lastUpdatedAt: new Date(),
        },
      });

      await this.recordEvent(
        record.id,
        `verification:${verification}`,
        actor,
        note
      );
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
      return {
        success: false,
        error: "Unable to update the verification state.",
      };
    }
  },

  /**
   * Edits an existing record.
   *
   * The smallest edit surface that makes the page usable: the figures a
   * customer actually gets wrong. Category and kind are fixed at creation,
   * because changing them would change which validation rules ever applied.
   *
   * Editing an amount re-checks the avoided-cost arithmetic, re-derives the
   * duplicate key so an edit cannot sneak past it, resets verification to
   * pending (the evidence someone confirmed is no longer the figure on the
   * record), and appends to the history.
   */
  update: async function ({ uuid, changes = {}, actor = null }) {
    try {
      const existing = await prisma.value_records.findUnique({
        where: { uuid: String(uuid) },
      });
      if (!existing)
        return { success: false, error: "Value record not found." };

      const spec = CATEGORIES[existing.category];
      if (!spec)
        return {
          success: false,
          error: "This record has an unknown category.",
        };

      const data = {};
      const changed = [];

      if (changes.amountCents !== undefined) {
        const amountCents = toCents(changes.amountCents);
        if (amountCents === null || amountCents <= 0)
          return {
            success: false,
            error: "Amount must be a positive number of cents.",
          };
        data.amount_cents = amountCents;
        changed.push("amount");
      }

      if (changes.period !== undefined) {
        const period = String(changes.period);
        if (!PERIOD_PATTERN.test(period))
          return {
            success: false,
            error: "Period must be a month in YYYY-MM form.",
          };
        data.period = period;
        changed.push("period");
      }

      if (changes.recurring !== undefined) {
        data.recurring = changes.recurring !== false;
        changed.push("recurring");
      }

      for (const [key, column, limit] of [
        ["description", "description", 1_000],
        ["evidenceRef", "evidence_ref", 300],
        ["evidenceNote", "evidence_note", 2_000],
        ["sourceSystem", "source_system", 120],
        ["sourceReference", "source_reference", 300],
        ["baselineApprovedBy", "baseline_approved_by", 200],
      ]) {
        if (changes[key] === undefined) continue;
        data[column] =
          changes[key] === null || changes[key] === ""
            ? null
            : String(changes[key]).slice(0, limit);
        changed.push(key);
      }

      if (changes.baselineCents !== undefined) {
        data.baseline_cents = toCents(changes.baselineCents);
        changed.push("baseline");
      }
      if (changes.measuredCents !== undefined) {
        data.measured_cents = toCents(changes.measuredCents);
        changed.push("measured");
      }

      if (!changed.length)
        return { success: false, error: "Nothing to change." };

      // An avoided cost must still stand up after the edit.
      if (spec.kind === KINDS.AVOIDED_COST) {
        const baseline = data.baseline_cents ?? existing.baseline_cents;
        const measured = data.measured_cents ?? existing.measured_cents;
        const amount = data.amount_cents ?? existing.amount_cents;
        const approvedBy =
          data.baseline_approved_by ?? existing.baseline_approved_by;

        if (baseline === null || measured === null)
          return {
            success: false,
            error:
              "An avoided cost needs both a customer-approved baseline and a measured figure.",
          };
        if (!approvedBy)
          return {
            success: false,
            error:
              "Record who approved the baseline before claiming an avoided cost.",
          };
        if (measured >= baseline)
          return {
            success: false,
            error:
              "The measured figure is not lower than the baseline, so no cost was avoided.",
          };
        if (amount > baseline - measured)
          return {
            success: false,
            error: `The claimed amount exceeds the measured saving of ${baseline - measured} cents.`,
          };
      }

      // Re-derive the duplicate key from the edited values, so an edit cannot
      // produce a record that duplicates another one.
      const dedupeKey = dedupeKeyFor({
        category: existing.category,
        period: data.period ?? existing.period,
        sourceSystem: data.source_system ?? existing.source_system,
        sourceReference: data.source_reference ?? existing.source_reference,
        evidenceRef: data.evidence_ref ?? existing.evidence_ref,
        amountCents: data.amount_cents ?? existing.amount_cents,
      });
      if (dedupeKey !== existing.dedupe_key) {
        const clash = await prisma.value_records.findUnique({
          where: { dedupe_key: dedupeKey },
        });
        if (clash && clash.uuid !== existing.uuid)
          return {
            success: false,
            error:
              "That edit would duplicate an existing record, so it was not saved.",
            duplicateOf: clash.uuid,
          };
        data.dedupe_key = dedupeKey;
      }

      // The figures changed, so any prior confirmation no longer describes
      // what is on the record.
      const figuresChanged = changed.some((field) =>
        ["amount", "period", "recurring", "baseline", "measured"].includes(
          field
        )
      );
      if (figuresChanged && existing.verification === VERIFICATION.VERIFIED) {
        data.verification = VERIFICATION.PENDING;
        data.verifiedBy = null;
        data.verifiedAt = null;
      }
      data.lastUpdatedAt = new Date();

      const record = await prisma.value_records.update({
        where: { uuid: String(uuid) },
        data,
      });

      await this.recordEvent(
        record.id,
        "edited",
        actor,
        `changed: ${changed.join(", ")}`
      );
      await AuditLog.log({
        action: "value.record_edited",
        category: AuditLog.CATEGORIES.SETTINGS,
        actor,
        resource: "value_record",
        resourceId: uuid,
        metadata: { changed, reverifyRequired: !!data.verification },
      });

      return {
        success: true,
        record,
        reverifyRequired: data.verification === VERIFICATION.PENDING,
      };
    } catch (error) {
      if (error?.code === "P2002")
        return {
          success: false,
          error:
            "That edit would duplicate an existing record, so it was not saved.",
        };
      console.error("[Value] update failed:", error.message);
      return { success: false, error: "Unable to update the value record." };
    }
  },

  recordEvent: async function (valueRecordId, action, actor, detail) {
    try {
      await prisma.value_record_events.create({
        data: {
          value_record_id: Number(valueRecordId),
          action: String(action).slice(0, 80),
          actor_id: actor?.id ? Number(actor.id) : null,
          actor_label: actor?.username
            ? String(actor.username).slice(0, 120)
            : null,
          detail: detail ? String(detail).slice(0, 1_000) : null,
        },
      });
    } catch (error) {
      console.error("[Value] history write failed:", error.message);
    }
  },

  history: async function (uuid) {
    try {
      const record = await prisma.value_records.findUnique({
        where: { uuid: String(uuid) },
      });
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
      const existing = await prisma.value_records.findUnique({
        where: { uuid: String(uuid) },
      });
      if (!existing)
        return { success: false, error: "Value record not found." };
      await prisma.value_record_events.deleteMany({
        where: { value_record_id: existing.id },
      });
      await prisma.value_records.delete({ where: { uuid: String(uuid) } });
      await AuditLog.log({
        action: "value.record_removed",
        category: AuditLog.CATEGORIES.SETTINGS,
        actor,
        resource: "value_record",
        resourceId: uuid,
        metadata: {
          category: existing.category,
          amountCents: existing.amount_cents,
        },
      });
      return { success: true };
    } catch (error) {
      console.error("[Value] delete failed:", error.message);
      return { success: false, error: "Unable to remove the value record." };
    }
  },

  /**
   * Every eligible record for a month, with no page limit.
   *
   * `where()` caps its result so a huge table cannot be pulled into memory by
   * accident. A monthly total must never be the sum of the first page, so this
   * pages through until the month is exhausted.
   */
  allForPeriod: async function (period) {
    const PAGE = 500;
    const rows = [];
    let cursorId = null;

    for (;;) {
      let page;
      try {
        page = await prisma.value_records.findMany({
          where: { period: String(period) },
          take: PAGE,
          ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
          orderBy: { id: "asc" },
        });
      } catch (error) {
        console.error("[Value] monthly read failed:", error.message);
        return rows;
      }
      if (!page?.length) break;
      rows.push(...page);
      if (page.length < PAGE) break;
      cursorId = page[page.length - 1].id;
    }
    return rows;
  },

  /**
   * The return-on-subscription figures for a month.
   *
   * Pure arithmetic, exported so the same rules can be unit-tested directly
   * and so a draft can be previewed without writing anything.
   *
   *   monthly benefit = eligible recurring savings + attributable gross profit
   *   return multiple = monthly benefit / fee
   *   net value       = monthly benefit - fee
   *   net ROI %       = ((monthly benefit - fee) / fee) * 100
   *
   * A missing or zero fee yields nulls, never Infinity, NaN or an invented
   * return.
   */
  computeReturn(benefitCents, feeCents) {
    const benefit = Number.isFinite(Number(benefitCents))
      ? Math.round(Number(benefitCents))
      : 0;
    const fee =
      Number.isFinite(Number(feeCents)) && Number(feeCents) > 0
        ? Math.round(Number(feeCents))
        : 0;

    if (fee <= 0) {
      return {
        monthlyBenefitCents: benefit,
        feeCents: fee,
        returnMultiple: null,
        netValueCents: null,
        netRoiPercent: null,
        feeAvailable: false,
      };
    }

    // Two decimals on the multiple, two on the percentage: enough to show a
    // fractional return honestly without implying precision that is not there.
    const multiple = Math.round((benefit / fee) * 100) / 100;
    const netValueCents = benefit - fee;
    const netRoiPercent = Math.round((netValueCents / fee) * 100 * 100) / 100;

    return {
      monthlyBenefitCents: benefit,
      feeCents: fee,
      returnMultiple: multiple,
      netValueCents,
      netRoiPercent,
      feeAvailable: true,
    };
  },

  /**
   * What the customer got back this month for what they pay.
   *
   * Recorded input counts immediately, so a customer sees their own entry move
   * the number without waiting for someone else. The verified subset is
   * reported alongside it, and the headline is labelled an estimate whenever
   * unverified records are part of it.
   */
  summary: async function (period = currentPeriod(), options = {}) {
    const fee = this.feeForPeriod(period);
    const currency = String(
      options.currency ?? fee.currency ?? "usd"
    ).toLowerCase();

    const all = await this.allForPeriod(period);

    // Rejected records are excluded outright - they are not evidence of
    // anything. Records in another currency are set aside and reported, never
    // summed into a total denominated in this one.
    const notRejected = all.filter(
      (r) => r.verification !== VERIFICATION.REJECTED
    );
    const rejectedCount = all.length - notRejected.length;

    const eligible = notRejected.filter(
      (r) => String(r.currency ?? "usd").toLowerCase() === currency
    );
    const otherCurrency = notRejected.filter(
      (r) => String(r.currency ?? "usd").toLowerCase() !== currency
    );

    const sum = (rows) =>
      rows.reduce((total, row) => total + (row.amount_cents ?? 0), 0);
    const split = (rows) => ({
      recurringCents: sum(rows.filter((r) => r.recurring)),
      oneTimeCents: sum(rows.filter((r) => !r.recurring)),
      recordCount: rows.length,
    });

    const verifiedRows = eligible.filter(
      (r) => r.verification === VERIFICATION.VERIFIED
    );
    const pendingRows = eligible.filter(
      (r) => r.verification === VERIFICATION.PENDING
    );

    const recorded = split(eligible);
    const verified = split(verifiedRows);
    const pending = split(pendingRows);

    // A one-time recovery is real value, but it does not recur, so it is kept
    // out of the monthly figure and shown on its own.
    const headline = this.computeReturn(
      recorded.recurringCents,
      fee.monthlyCents
    );
    const verifiedOnly = this.computeReturn(
      verified.recurringCents,
      fee.monthlyCents
    );

    const includesEstimates = pending.recordCount > 0;

    const basisFor = (key) => CATEGORIES[key]?.basis ?? null;
    const byBasis = (rows) => {
      const totals = { gross_profit: 0, cash_saving: 0, time_valued: 0 };
      for (const row of rows) {
        if (!row.recurring) continue;
        const basis = basisFor(row.category);
        if (basis && basis in totals) totals[basis] += row.amount_cents ?? 0;
      }
      return totals;
    };

    return {
      period: String(period),
      currency,
      fee,

      // The headline: everything recorded and not rejected.
      monthlyBenefitCents: headline.monthlyBenefitCents,
      returnMultiple: headline.returnMultiple,
      netValueCents: headline.netValueCents,
      netRoiPercent: headline.netRoiPercent,
      feeAvailable: headline.feeAvailable,

      includesEstimates,
      headlineLabel: includesEstimates
        ? "Estimated return"
        : "Return on subscription",
      headlineNote: includesEstimates
        ? "Based on recorded inputs - includes estimates awaiting verification."
        : null,

      recorded,
      verified,
      pending,
      rejected: { recordCount: rejectedCount },

      // The same arithmetic on the verified subset only, so the evidenced
      // portion stays separately identifiable without being counted twice.
      verifiedOnly: {
        monthlyBenefitCents: verifiedOnly.monthlyBenefitCents,
        returnMultiple: verifiedOnly.returnMultiple,
        netValueCents: verifiedOnly.netValueCents,
        netRoiPercent: verifiedOnly.netRoiPercent,
      },

      // Hours valued at a rate are not the same money as a bill that stopped
      // arriving, so they are never merged into one "savings" number.
      breakdown: {
        recorded: byBasis(eligible),
        verified: byBasis(verifiedRows),
      },

      byCategory: Object.fromEntries(
        Object.keys(CATEGORIES).map((key) => [
          key,
          sum(eligible.filter((r) => r.recurring && r.category === key)),
        ])
      ),

      otherCurrencies: {
        recordCount: otherCurrency.length,
        currencies: [
          ...new Set(
            otherCurrency.map((r) => String(r.currency ?? "").toLowerCase())
          ),
        ].filter(Boolean),
        note: otherCurrency.length
          ? "Records in another currency are listed but not added to this total."
          : null,
      },

      hasInput: eligible.length > 0,
    };
  },

  /**
   * "Estimate value": given savings and gross profit a business expects, what
   * multiple of the subscription would that be?
   *
   * It answers the customer's question. It sets no target and names no
   * multiple to work toward.
   */
  estimateReturn({
    recurringSavingsCents = 0,
    grossProfitCents = 0,
    period = currentPeriod(),
  } = {}) {
    const clean = (value) => {
      const number = Number(value);
      return Number.isFinite(number) && number > 0 ? Math.round(number) : 0;
    };

    const savings = clean(recurringSavingsCents);
    const profit = clean(grossProfitCents);
    const benefitCents = savings + profit;

    const fee = this.feeForPeriod(period);
    const result = this.computeReturn(benefitCents, fee.monthlyCents);

    return {
      fee,
      inputs: { recurringSavingsCents: savings, grossProfitCents: profit },
      benefitCents,
      returnMultiple: result.returnMultiple,
      netValueCents: result.netValueCents,
      netRoiPercent: result.netRoiPercent,
      feeAvailable: result.feeAvailable,
      isEstimate: true,
      note: "An estimate from the figures entered here. It is not a measured result and nothing is saved.",
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

module.exports = { ValueRecords, KINDS, VERIFICATION, CATEGORIES, BASIS };

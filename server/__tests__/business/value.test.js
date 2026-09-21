/**
 * Return on subscription.
 *
 * The figure is the customer's own return and it moves with their inputs.
 * These tests hold the arithmetic and the honesty rules: a lead is never
 * revenue, a one-time recovery never inflates a monthly multiple, rejected
 * records are excluded, currencies are never silently summed, a month is
 * aggregated in full, and a missing fee yields no number rather than a
 * fabricated one.
 */

const FEE_CENTS = 388888; // $3,888.88

/** In-memory stand-in for the two value tables. */
function makeDb() {
  const state = { records: [], events: [], nextId: 1 };
  const find = (uuid) => state.records.find((r) => r.uuid === uuid) ?? null;

  return {
    state,
    client: {
      value_records: {
        findUnique: async ({ where }) =>
          where.uuid
            ? find(where.uuid)
            : (state.records.find((r) => r.dedupe_key === where.dedupe_key) ?? null),
        // Mirrors enough of Prisma's paging for the monthly aggregation to be
        // exercised for real rather than assumed.
        findMany: async ({ where = {}, take = null, cursor = null, skip = 0 }) => {
          let rows = state.records
            .filter((r) =>
              Object.entries(where).every(([key, value]) => r[key] === value)
            )
            .sort((a, b) => a.id - b.id);
          if (cursor) {
            const at = rows.findIndex((r) => r.id === cursor.id);
            rows = at === -1 ? [] : rows.slice(at + skip);
          }
          return take ? rows.slice(0, take) : rows;
        },
        create: async ({ data }) => {
          if (state.records.some((r) => r.dedupe_key === data.dedupe_key)) {
            const error = new Error("unique");
            error.code = "P2002";
            throw error;
          }
          const row = { id: state.nextId++, verifiedAt: null, ...data };
          state.records.push(row);
          return row;
        },
        update: async ({ where, data }) => {
          const row = find(where.uuid);
          Object.assign(row, data);
          return row;
        },
        delete: async ({ where }) => {
          state.records = state.records.filter((r) => r.uuid !== where.uuid);
          return {};
        },
      },
      value_record_events: {
        create: async ({ data }) => {
          state.events.push(data);
          return data;
        },
        findMany: async ({ where }) =>
          state.events.filter((e) => e.value_record_id === where.value_record_id),
        deleteMany: async () => ({ count: 0 }),
      },
      audit_logs: { create: async () => ({}) },
    },
  };
}

function load(db) {
  jest.resetModules();
  delete process.env.PLAN_AMOUNT_CENTS;
  jest.doMock("../../utils/prisma", () => db.client);
  return require("../../business/models/value");
}

const CREATOR = { id: 1, username: "manager" };
const VERIFIER = { id: 2, username: "owner" };

/** A well-formed closed-won record. */
function profitRecord(overrides = {}) {
  return {
    category: "closed_won_revenue",
    period: "2026-09",
    amountCents: 1_000_000,
    evidenceRef: "INV-1001",
    sourceSystem: "crm",
    sourceReference: "opp-1001",
    description: "Closed deal attributed to the website agent",
    ...overrides,
  };
}

afterEach(() => jest.resetModules());

describe("what may be counted", () => {
  it("rejects an unknown category, so a lead cannot be filed as revenue", async () => {
    const db = makeDb();
    const { ValueRecords } = load(db);
    const result = await ValueRecords.create(
      { category: "captured_lead", period: "2026-09", amountCents: 500000 },
      { actor: CREATOR }
    );
    expect(result.record).toBeNull();
    expect(result.error).toMatch(/Unknown value category/);
  });

  it("offers no category that treats a lead as revenue", () => {
    const db = makeDb();
    const { CATEGORIES } = load(db);
    for (const [key, spec] of Object.entries(CATEGORIES)) {
      expect(key).not.toMatch(/lead/i);
      expect(spec.label).not.toMatch(/lead/i);
    }
  });

  it("only counts revenue as realized GROSS PROFIT", () => {
    const db = makeDb();
    const { CATEGORIES, KINDS } = load(db);
    const revenue = Object.values(CATEGORIES).filter(
      (c) => c.kind === KINDS.REALIZED_GROSS_PROFIT
    );
    expect(revenue.length).toBeGreaterThan(0);
    for (const spec of revenue) expect(spec.label).toMatch(/gross profit/i);
  });

  it("rejects a non-positive amount", async () => {
    const db = makeDb();
    const { ValueRecords } = load(db);
    for (const amountCents of [0, -100, "abc"]) {
      const result = await ValueRecords.create(profitRecord({ amountCents }), { actor: CREATOR });
      expect(result.record).toBeNull();
    }
  });

  it("rejects a malformed period", async () => {
    const db = makeDb();
    const { ValueRecords } = load(db);
    const result = await ValueRecords.create(profitRecord({ period: "September" }), {
      actor: CREATOR,
    });
    expect(result.error).toMatch(/YYYY-MM/);
  });
});

describe("avoided cost requires a baseline and a measurement", () => {
  const base = {
    category: "support_deflection",
    period: "2026-09",
    amountCents: 200_000,
  };

  it("refuses without a baseline", async () => {
    const db = makeDb();
    const { ValueRecords } = load(db);
    const result = await ValueRecords.create(
      { ...base, measuredCents: 300_000, baselineApprovedBy: "CFO" },
      { actor: CREATOR }
    );
    expect(result.error).toMatch(/baseline/i);
  });

  it("refuses without a recorded approver", async () => {
    const db = makeDb();
    const { ValueRecords } = load(db);
    const result = await ValueRecords.create(
      { ...base, baselineCents: 600_000, measuredCents: 300_000 },
      { actor: CREATOR }
    );
    expect(result.error).toMatch(/approved the baseline/i);
  });

  it("refuses when the measured figure is not lower than the baseline", async () => {
    const db = makeDb();
    const { ValueRecords } = load(db);
    const result = await ValueRecords.create(
      {
        ...base,
        baselineCents: 300_000,
        measuredCents: 300_000,
        baselineApprovedBy: "CFO",
      },
      { actor: CREATOR }
    );
    expect(result.error).toMatch(/no cost was avoided/i);
  });

  it("refuses a claim larger than the measured saving", async () => {
    const db = makeDb();
    const { ValueRecords } = load(db);
    const result = await ValueRecords.create(
      {
        ...base,
        amountCents: 500_000,
        baselineCents: 600_000,
        measuredCents: 300_000,
        baselineApprovedBy: "CFO",
      },
      { actor: CREATOR }
    );
    expect(result.error).toMatch(/exceeds the measured saving/i);
  });

  it("accepts a properly evidenced avoided cost", async () => {
    const db = makeDb();
    const { ValueRecords } = load(db);
    const result = await ValueRecords.create(
      {
        ...base,
        baselineCents: 600_000,
        measuredCents: 300_000,
        baselineApprovedBy: "CFO",
        evidenceRef: "BASELINE-2026-08",
      },
      { actor: CREATOR }
    );
    expect(result.record).toBeTruthy();
  });
});

describe("duplicate prevention", () => {
  it("refuses the same source event twice", async () => {
    const db = makeDb();
    const { ValueRecords } = load(db);
    const first = await ValueRecords.create(profitRecord(), { actor: CREATOR });
    expect(first.record).toBeTruthy();

    const second = await ValueRecords.create(profitRecord(), { actor: CREATOR });
    expect(second.record).toBeNull();
    expect(second.error).toMatch(/not counted twice/i);
    expect(second.duplicateOf).toBe(first.record.uuid);
    expect(db.state.records).toHaveLength(1);
  });

  it("allows the same source reference in a different month", async () => {
    const db = makeDb();
    const { ValueRecords } = load(db);
    await ValueRecords.create(profitRecord({ period: "2026-09" }), { actor: CREATOR });
    const next = await ValueRecords.create(profitRecord({ period: "2026-10" }), {
      actor: CREATOR,
    });
    expect(next.record).toBeTruthy();
  });

  it("distinguishes different source references", async () => {
    const db = makeDb();
    const { ValueRecords } = load(db);
    await ValueRecords.create(profitRecord({ sourceReference: "opp-1" }), { actor: CREATOR });
    const other = await ValueRecords.create(profitRecord({ sourceReference: "opp-2" }), {
      actor: CREATOR,
    });
    expect(other.record).toBeTruthy();
  });
});

describe("verification", () => {
  async function created() {
    const db = makeDb();
    const mod = load(db);
    const { record } = await mod.ValueRecords.create(profitRecord(), { actor: CREATOR });
    return { db, ...mod, record };
  }

  it("starts every record unverified", async () => {
    const { record, VERIFICATION } = await created();
    expect(record.verification).toBe(VERIFICATION.PENDING);
  });

  it("refuses verification without an evidence reference", async () => {
    const db = makeDb();
    const { ValueRecords, VERIFICATION } = load(db);
    const { record } = await ValueRecords.create(profitRecord({ evidenceRef: null }), {
      actor: CREATOR,
    });
    const result = await ValueRecords.setVerification({
      uuid: record.uuid,
      verification: VERIFICATION.VERIFIED,
      actor: VERIFIER,
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/evidence reference/i);
  });

  it("refuses self-verification by the record's creator", async () => {
    const { ValueRecords, VERIFICATION, record } = await created();
    const result = await ValueRecords.setVerification({
      uuid: record.uuid,
      verification: VERIFICATION.VERIFIED,
      actor: CREATOR,
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/other than the person who created it/i);
  });

  it("accepts verification by a different person", async () => {
    const { ValueRecords, VERIFICATION, record } = await created();
    const result = await ValueRecords.setVerification({
      uuid: record.uuid,
      verification: VERIFICATION.VERIFIED,
      actor: VERIFIER,
    });
    expect(result.success).toBe(true);
    expect(result.record.verifiedBy).toBe(VERIFIER.id);
    expect(result.record.verifiedAt).toBeTruthy();
  });

  it("writes an append-only history entry for each change", async () => {
    const { ValueRecords, VERIFICATION, record, db } = await created();
    await ValueRecords.setVerification({
      uuid: record.uuid,
      verification: VERIFICATION.VERIFIED,
      actor: VERIFIER,
      note: "Checked against INV-1001",
    });
    const history = await ValueRecords.history(record.uuid);
    expect(history.map((h) => h.action)).toEqual([
      "created",
      "verification:verified",
    ]);
    expect(db.state.events.at(-1).actor_label).toBe(VERIFIER.username);
  });
});

describe("return on subscription", () => {
  async function withRecords(rows) {
    const db = makeDb();
    const mod = load(db);
    for (const row of rows) {
      const { record } = await mod.ValueRecords.create(row.input, {
        actor: CREATOR,
      });
      if (row.verification && record)
        await mod.ValueRecords.setVerification({
          uuid: record.uuid,
          verification: row.verification,
          actor: VERIFIER,
        });
    }
    return mod;
  }

  it("shows 30x for $116,666.40 of benefit at a $3,888.88 fee", async () => {
    const { ValueRecords } = await withRecords([
      { input: profitRecord({ amountCents: 11_666_640 }) },
    ]);
    const summary = await ValueRecords.summary("2026-09");
    expect(summary.fee.monthlyCents).toBe(FEE_CENTS);
    expect(summary.monthlyBenefitCents).toBe(11_666_640);
    expect(summary.returnMultiple).toBe(30);
    // The same result stated as a percentage: 2,900% net ROI.
    expect(summary.netRoiPercent).toBe(2900);
    expect(summary.netValueCents).toBe(11_666_640 - FEE_CENTS);
  });

  it("shows 82x for $318,888.16 of benefit at the same fee", async () => {
    const { ValueRecords } = await withRecords([
      { input: profitRecord({ amountCents: 31_888_816 }) },
    ]);
    const summary = await ValueRecords.summary("2026-09");
    expect(summary.returnMultiple).toBe(82);
    expect(summary.netRoiPercent).toBe(8100);
  });

  it("treats 30x and 82x as ordinary results with no verdict attached", async () => {
    for (const amountCents of [11_666_640, 31_888_816]) {
      const { ValueRecords } = await withRecords([
        { input: profitRecord({ amountCents }) },
      ]);
      const summary = await ValueRecords.summary("2026-09");
      const serialized = JSON.stringify(summary);
      expect(serialized).not.toMatch(/qualif/i);
      expect(serialized).not.toMatch(/threshold/i);
      expect(serialized).not.toMatch(/shortfall/i);
      expect(summary.status).toBeUndefined();
    }
  });

  it("supports fractional multiples", async () => {
    const { ValueRecords } = await withRecords([
      { input: profitRecord({ amountCents: 583_332 }) }, // 1.5x the fee
    ]);
    const summary = await ValueRecords.summary("2026-09");
    expect(summary.returnMultiple).toBe(1.5);
    expect(summary.netRoiPercent).toBe(50);
  });

  it("reports a below-cost month honestly, with negative net value", async () => {
    const { ValueRecords } = await withRecords([
      { input: profitRecord({ amountCents: 100_000 }) },
    ]);
    const summary = await ValueRecords.summary("2026-09");
    expect(summary.returnMultiple).toBeCloseTo(0.26, 2);
    expect(summary.netValueCents).toBe(100_000 - FEE_CENTS);
    expect(summary.netValueCents).toBeLessThan(0);
    expect(summary.netRoiPercent).toBeLessThan(0);
  });

  it("places no cap above 100x", async () => {
    const { ValueRecords } = await withRecords([
      { input: profitRecord({ amountCents: FEE_CENTS * 250 }) },
    ]);
    const summary = await ValueRecords.summary("2026-09");
    expect(summary.returnMultiple).toBe(250);
  });

  it("returns no multiple at all when the fee is zero or missing", () => {
    const db = makeDb();
    const { ValueRecords } = load(db);
    for (const feeCents of [0, null, undefined, NaN, -100, "abc"]) {
      const result = ValueRecords.computeReturn(5_000_000, feeCents);
      expect(result.feeAvailable).toBe(false);
      expect(result.returnMultiple).toBeNull();
      expect(result.netValueCents).toBeNull();
      expect(result.netRoiPercent).toBeNull();
      // No Infinity, no NaN, no invented return.
      expect(JSON.stringify(result)).not.toMatch(/Infinity|NaN/);
    }
  });

  it("produces no Infinity or NaN anywhere in a summary", async () => {
    const { ValueRecords } = await withRecords([
      { input: profitRecord({ amountCents: 11_666_640 }) },
    ]);
    const summary = await ValueRecords.summary("2026-09");
    expect(JSON.stringify(summary)).not.toMatch(/Infinity|NaN|null,"netValue/);
  });

  it("keeps the configured fee when PLAN_AMOUNT_CENTS is not a usable number", async () => {
    const db = makeDb();
    jest.resetModules();
    process.env.PLAN_AMOUNT_CENTS = "0";
    jest.doMock("../../utils/prisma", () => db.client);
    const { ValueRecords } = require("../../business/models/value");
    const summary = await ValueRecords.summary("2026-09");
    delete process.env.PLAN_AMOUNT_CENTS;
    // Configuration refuses a zero price rather than reporting a free plan.
    expect(summary.fee.monthlyCents).toBe(FEE_CENTS);
    expect(summary.fee.available).toBe(true);
  });

  it("is empty and informative before anything is recorded", async () => {
    const { ValueRecords } = await withRecords([]);
    const summary = await ValueRecords.summary("2026-09");
    expect(summary.hasInput).toBe(false);
    expect(summary.monthlyBenefitCents).toBe(0);
    expect(summary.returnMultiple).toBe(0);
    expect(summary.recorded.recordCount).toBe(0);
    expect(summary.includesEstimates).toBe(false);
  });

  it("counts a customer's own record immediately, labelled an estimate", async () => {
    const { ValueRecords } = await withRecords([
      { input: profitRecord({ amountCents: 11_666_640 }) },
    ]);
    const summary = await ValueRecords.summary("2026-09");
    expect(summary.returnMultiple).toBe(30);
    expect(summary.includesEstimates).toBe(true);
    expect(summary.headlineLabel).toMatch(/estimated/i);
    expect(summary.headlineNote).toMatch(/includes estimates/i);
    // The evidenced portion stays separately identifiable.
    expect(summary.verifiedOnly.monthlyBenefitCents).toBe(0);
    expect(summary.verifiedOnly.returnMultiple).toBe(0);
  });

  it("drops the estimate label once everything is verified", async () => {
    const { ValueRecords } = await withRecords([
      { input: profitRecord({ amountCents: 11_666_640 }), verification: "verified" },
    ]);
    const summary = await ValueRecords.summary("2026-09");
    expect(summary.includesEstimates).toBe(false);
    expect(summary.headlineLabel).toBe("Return on subscription");
    expect(summary.verifiedOnly.returnMultiple).toBe(30);
  });

  it("moves a record between portions on verification without double counting", async () => {
    const db = makeDb();
    const mod = load(db);
    const { record } = await mod.ValueRecords.create(
      profitRecord({ amountCents: 11_666_640 }),
      { actor: CREATOR }
    );

    let summary = await mod.ValueRecords.summary("2026-09");
    expect(summary.pending.recurringCents).toBe(11_666_640);
    expect(summary.verified.recurringCents).toBe(0);
    expect(summary.monthlyBenefitCents).toBe(11_666_640);

    await mod.ValueRecords.setVerification({
      uuid: record.uuid,
      verification: mod.VERIFICATION.VERIFIED,
      actor: VERIFIER,
    });

    summary = await mod.ValueRecords.summary("2026-09");
    expect(summary.pending.recurringCents).toBe(0);
    expect(summary.verified.recurringCents).toBe(11_666_640);
    // Still counted exactly once.
    expect(summary.monthlyBenefitCents).toBe(11_666_640);
    expect(summary.returnMultiple).toBe(30);
  });

  it("excludes a rejected record from every figure", async () => {
    const { ValueRecords } = await withRecords([
      { input: profitRecord({ amountCents: 11_666_640 }) },
      {
        input: profitRecord({
          amountCents: 90_000_000,
          sourceReference: "opp-bogus",
        }),
        verification: "rejected",
      },
    ]);
    const summary = await ValueRecords.summary("2026-09");
    expect(summary.monthlyBenefitCents).toBe(11_666_640);
    expect(summary.returnMultiple).toBe(30);
    expect(summary.rejected.recordCount).toBe(1);
  });

  it("keeps a one-time recovery out of the monthly multiple", async () => {
    const { ValueRecords } = await withRecords([
      { input: profitRecord({ amountCents: 11_666_640 }) },
      {
        input: profitRecord({
          amountCents: 40_000_000,
          recurring: false,
          sourceReference: "one-off",
        }),
      },
    ]);
    const summary = await ValueRecords.summary("2026-09");
    expect(summary.recorded.oneTimeCents).toBe(40_000_000);
    expect(summary.monthlyBenefitCents).toBe(11_666_640);
    expect(summary.returnMultiple).toBe(30);
  });

  it("does not repeat a one-time recovery into a later month", async () => {
    const { ValueRecords } = await withRecords([
      {
        input: profitRecord({
          amountCents: 40_000_000,
          recurring: false,
          sourceReference: "one-off",
        }),
      },
    ]);
    const next = await ValueRecords.summary("2026-10");
    expect(next.recorded.oneTimeCents).toBe(0);
    expect(next.monthlyBenefitCents).toBe(0);
    expect(next.hasInput).toBe(false);
  });

  it("only counts the selected month", async () => {
    const { ValueRecords } = await withRecords([
      { input: profitRecord({ amountCents: 11_666_640, period: "2026-09" }) },
      { input: profitRecord({ amountCents: 90_000_000, period: "2026-08" }) },
    ]);
    const summary = await ValueRecords.summary("2026-09");
    expect(summary.period).toBe("2026-09");
    expect(summary.monthlyBenefitCents).toBe(11_666_640);
  });

  it("never sums different currencies into one total", async () => {
    const { ValueRecords } = await withRecords([
      { input: profitRecord({ amountCents: 11_666_640 }) },
      {
        input: profitRecord({
          amountCents: 50_000_000,
          currency: "eur",
          sourceReference: "opp-eur",
        }),
      },
    ]);
    const summary = await ValueRecords.summary("2026-09");
    expect(summary.currency).toBe("usd");
    expect(summary.monthlyBenefitCents).toBe(11_666_640);
    expect(summary.otherCurrencies.recordCount).toBe(1);
    expect(summary.otherCurrencies.currencies).toEqual(["eur"]);
  });

  it("can report a month in another currency on request", async () => {
    const { ValueRecords } = await withRecords([
      { input: profitRecord({ amountCents: 11_666_640 }) },
      {
        input: profitRecord({
          amountCents: 777_776,
          currency: "eur",
          sourceReference: "opp-eur",
        }),
      },
    ]);
    const summary = await ValueRecords.summary("2026-09", { currency: "eur" });
    expect(summary.currency).toBe("eur");
    expect(summary.monthlyBenefitCents).toBe(777_776);
    expect(summary.otherCurrencies.currencies).toEqual(["usd"]);
  });

  it("aggregates the whole month, not just the first page", async () => {
    const db = makeDb();
    const mod = load(db);
    // More than one page of the paged read (500), each worth $1.00.
    for (let index = 0; index < 640; index += 1) {
      await mod.ValueRecords.create(
        profitRecord({ amountCents: 100, sourceReference: `opp-${index}` }),
        { actor: CREATOR }
      );
    }
    const summary = await mod.ValueRecords.summary("2026-09");
    expect(summary.recorded.recordCount).toBe(640);
    expect(summary.monthlyBenefitCents).toBe(64_000);
  });

  it("reports time valued apart from an actual cash reduction", async () => {
    const { ValueRecords } = await withRecords([
      {
        input: {
          category: "staff_time_avoided",
          period: "2026-09",
          amountCents: 300_000,
          baselineCents: 900_000,
          measuredCents: 500_000,
          baselineApprovedBy: "COO",
          evidenceRef: "TIME-1",
        },
      },
      {
        input: {
          category: "vendor_cost_avoided",
          period: "2026-09",
          amountCents: 200_000,
          baselineCents: 400_000,
          measuredCents: 100_000,
          baselineApprovedBy: "CFO",
          evidenceRef: "VENDOR-1",
        },
      },
      { input: profitRecord({ amountCents: 500_000 }) },
    ]);
    const summary = await ValueRecords.summary("2026-09");
    expect(summary.breakdown.recorded.time_valued).toBe(300_000);
    expect(summary.breakdown.recorded.cash_saving).toBe(200_000);
    expect(summary.breakdown.recorded.gross_profit).toBe(500_000);
    // They still add up to the benefit, but they are never merged.
    expect(summary.monthlyBenefitCents).toBe(1_000_000);
  });

  it("does not count the same underlying benefit twice", async () => {
    const { ValueRecords } = await withRecords([
      { input: profitRecord({ amountCents: 11_666_640 }) },
      { input: profitRecord({ amountCents: 11_666_640 }) }, // same event
    ]);
    const summary = await ValueRecords.summary("2026-09");
    expect(summary.recorded.recordCount).toBe(1);
    expect(summary.returnMultiple).toBe(30);
  });

  it("discloses that a past month's fee is an assumption", async () => {
    const { ValueRecords } = await withRecords([]);
    const past = await ValueRecords.summary("2020-01");
    expect(past.fee.isAssumption).toBe(true);
    expect(past.fee.note).toMatch(/assumption/i);
    expect(past.fee.source).toBe("configured");

    const current = await ValueRecords.summary(ValueRecords.currentPeriod());
    expect(current.fee.isAssumption).toBe(false);
    expect(current.fee.note).toBeNull();
  });
});

describe("recomputation after an edit", () => {
  it("moves the return when an amount is edited", async () => {
    const db = makeDb();
    const mod = load(db);
    const { record } = await mod.ValueRecords.create(
      profitRecord({ amountCents: 11_666_640 }),
      { actor: CREATOR }
    );
    expect((await mod.ValueRecords.summary("2026-09")).returnMultiple).toBe(30);

    const result = await mod.ValueRecords.update({
      uuid: record.uuid,
      changes: { amountCents: 31_888_816 },
      actor: CREATOR,
    });
    expect(result.success).toBe(true);
    expect((await mod.ValueRecords.summary("2026-09")).returnMultiple).toBe(82);
  });

  it("returns an edited record to unverified when its figures change", async () => {
    const db = makeDb();
    const mod = load(db);
    const { record } = await mod.ValueRecords.create(
      profitRecord({ amountCents: 11_666_640 }),
      { actor: CREATOR }
    );
    await mod.ValueRecords.setVerification({
      uuid: record.uuid,
      verification: mod.VERIFICATION.VERIFIED,
      actor: VERIFIER,
    });

    const result = await mod.ValueRecords.update({
      uuid: record.uuid,
      changes: { amountCents: 20_000_000 },
      actor: CREATOR,
    });
    expect(result.reverifyRequired).toBe(true);

    const summary = await mod.ValueRecords.summary("2026-09");
    expect(summary.verified.recurringCents).toBe(0);
    expect(summary.pending.recurringCents).toBe(20_000_000);
    expect(summary.monthlyBenefitCents).toBe(20_000_000);
  });

  it("keeps a verification when only a description changes", async () => {
    const db = makeDb();
    const mod = load(db);
    const { record } = await mod.ValueRecords.create(
      profitRecord({ amountCents: 11_666_640 }),
      { actor: CREATOR }
    );
    await mod.ValueRecords.setVerification({
      uuid: record.uuid,
      verification: mod.VERIFICATION.VERIFIED,
      actor: VERIFIER,
    });
    const result = await mod.ValueRecords.update({
      uuid: record.uuid,
      changes: { description: "clarified attribution" },
      actor: CREATOR,
    });
    expect(result.success).toBe(true);
    expect(result.reverifyRequired).toBe(false);
    expect((await mod.ValueRecords.summary("2026-09")).verified.recurringCents).toBe(
      11_666_640
    );
  });

  it("moves a record to another month when its period is edited", async () => {
    const db = makeDb();
    const mod = load(db);
    const { record } = await mod.ValueRecords.create(
      profitRecord({ amountCents: 11_666_640 }),
      { actor: CREATOR }
    );
    await mod.ValueRecords.update({
      uuid: record.uuid,
      changes: { period: "2026-10" },
      actor: CREATOR,
    });
    expect((await mod.ValueRecords.summary("2026-09")).monthlyBenefitCents).toBe(0);
    expect((await mod.ValueRecords.summary("2026-10")).returnMultiple).toBe(30);
  });

  it("refuses an edit that would duplicate another record", async () => {
    const db = makeDb();
    const mod = load(db);
    await mod.ValueRecords.create(
      profitRecord({ amountCents: 100_000, sourceReference: "opp-a" }),
      { actor: CREATOR }
    );
    const second = await mod.ValueRecords.create(
      profitRecord({ amountCents: 200_000, sourceReference: "opp-b" }),
      { actor: CREATOR }
    );
    const result = await mod.ValueRecords.update({
      uuid: second.record.uuid,
      changes: { sourceReference: "opp-a", amountCents: 100_000 },
      actor: CREATOR,
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/duplicate/i);
  });

  it("rejects an invalid edited amount and changes nothing", async () => {
    const db = makeDb();
    const mod = load(db);
    const { record } = await mod.ValueRecords.create(
      profitRecord({ amountCents: 11_666_640 }),
      { actor: CREATOR }
    );
    for (const amountCents of [0, -5, "abc"]) {
      const result = await mod.ValueRecords.update({
        uuid: record.uuid,
        changes: { amountCents },
        actor: CREATOR,
      });
      expect(result.success).toBe(false);
    }
    expect((await mod.ValueRecords.summary("2026-09")).returnMultiple).toBe(30);
  });

  it("re-checks the avoided-cost arithmetic on edit", async () => {
    const db = makeDb();
    const mod = load(db);
    const { record } = await mod.ValueRecords.create(
      {
        category: "support_deflection",
        period: "2026-09",
        amountCents: 200_000,
        baselineCents: 600_000,
        measuredCents: 300_000,
        baselineApprovedBy: "CFO",
        evidenceRef: "SUP-1",
      },
      { actor: CREATOR }
    );
    const result = await mod.ValueRecords.update({
      uuid: record.uuid,
      changes: { amountCents: 500_000 },
      actor: CREATOR,
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/exceeds the measured saving/i);
  });

  it("writes an audit history entry for an edit", async () => {
    const db = makeDb();
    const mod = load(db);
    const { record } = await mod.ValueRecords.create(
      profitRecord({ amountCents: 11_666_640 }),
      { actor: CREATOR }
    );
    await mod.ValueRecords.update({
      uuid: record.uuid,
      changes: { amountCents: 12_000_000 },
      actor: CREATOR,
    });
    const history = await mod.ValueRecords.history(record.uuid);
    expect(history.some((event) => event.action === "edited")).toBe(true);
  });
});

describe("the estimate calculator", () => {
  it("returns the multiple the entered figures come to", () => {
    const db = makeDb();
    const { ValueRecords } = load(db);
    const estimate = ValueRecords.estimateReturn({
      recurringSavingsCents: 6_666_640,
      grossProfitCents: 5_000_000,
    });
    expect(estimate.benefitCents).toBe(11_666_640);
    expect(estimate.returnMultiple).toBe(30);
    expect(estimate.netRoiPercent).toBe(2900);
    expect(estimate.isEstimate).toBe(true);
  });

  it("sets no target and names no multiple to reach", () => {
    const db = makeDb();
    const { ValueRecords } = load(db);
    const estimate = ValueRecords.estimateReturn({ grossProfitCents: 1_000_000 });
    const serialized = JSON.stringify(estimate);
    expect(serialized).not.toMatch(/qualif/i);
    expect(serialized).not.toMatch(/required/i);
    expect(serialized).not.toMatch(/threshold/i);
    expect(estimate.note).toMatch(/not a measured result/i);
  });

  it("handles empty and invalid inputs without inventing a return", () => {
    const db = makeDb();
    const { ValueRecords } = load(db);
    const estimate = ValueRecords.estimateReturn({
      recurringSavingsCents: "abc",
      grossProfitCents: -50,
    });
    expect(estimate.benefitCents).toBe(0);
    expect(estimate.returnMultiple).toBe(0);
  });
});

describe("the old qualification behaviour is gone", () => {
  it("exports no thresholds and no qualification calculator", () => {
    const db = makeDb();
    const mod = load(db);
    expect(mod.THRESHOLDS).toBeUndefined();
    expect(mod.ValueRecords.THRESHOLDS).toBeUndefined();
    expect(mod.ValueRecords.qualificationScenarios).toBeUndefined();
  });

  it("keeps no 90 or 100 multiple anywhere in the model source", () => {
    const source = require("fs").readFileSync(
      require.resolve("../../business/models/value.js"),
      "utf8"
    );
    expect(source).not.toMatch(/QUALIFIED_90X|QUALIFIED_100X/);
    expect(source).not.toMatch(/qualified_90x|qualified_100x|below_90x/);
  });
});

describe("CSV export", () => {
  it("neutralises spreadsheet formula injection", () => {
    const db = makeDb();
    const { ValueRecords } = load(db);
    const csv = ValueRecords.toCSV([
      { period: "2026-09", category: "closed_won_revenue", description: "=cmd|calc" },
    ]);
    expect(csv).toContain(`"'=cmd|calc"`);
  });
});

describe("the fee follows PLAN_AMOUNT_CENTS", () => {
  afterEach(() => delete process.env.PLAN_AMOUNT_CENTS);

  it("measures the return against the configured fee, whatever it is", async () => {
    const db = makeDb();
    jest.resetModules();
    process.env.PLAN_AMOUNT_CENTS = "500000"; // $5,000.00
    jest.doMock("../../utils/prisma", () => db.client);
    const { ValueRecords } = require("../../business/models/value");

    await ValueRecords.create(profitRecord({ amountCents: 15_000_000 }), {
      actor: CREATOR,
    });
    const summary = await ValueRecords.summary("2026-09");
    expect(summary.fee.monthlyCents).toBe(500000);
    expect(summary.returnMultiple).toBe(30);
  });
});

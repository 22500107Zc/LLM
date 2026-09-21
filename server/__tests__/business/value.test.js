/**
 * Realized-value evidence.
 *
 * The commercial claim is a multiple of the monthly fee. These tests exist to
 * make that claim falsifiable: nothing counts until a second person verifies
 * it against named evidence, a lead is never revenue, a one-time recovery
 * never inflates a monthly multiple, and the same event cannot be counted
 * twice.
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
        findMany: async ({ where = {} }) =>
          state.records.filter((r) =>
            Object.entries(where).every(([key, value]) => r[key] === value)
          ),
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

describe("qualification summary", () => {
  async function withRecords(rows) {
    const db = makeDb();
    const mod = load(db);
    for (const row of rows) {
      const { record } = await mod.ValueRecords.create(row.input, { actor: CREATOR });
      if (row.verified && record)
        await mod.ValueRecords.setVerification({
          uuid: record.uuid,
          verification: mod.VERIFICATION.VERIFIED,
          actor: VERIFIER,
        });
    }
    return mod;
  }

  it("uses the configured fee and the stated thresholds", async () => {
    const { ValueRecords } = await withRecords([]);
    const summary = await ValueRecords.summary("2026-09");
    expect(summary.fee.monthlyCents).toBe(FEE_CENTS);
    // 90x = $349,999.20 and 100x = $388,888.00
    expect(summary.thresholds.x90.requiredCents).toBe(34_999_920);
    expect(summary.thresholds.x100.requiredCents).toBe(38_888_800);
  });

  it("counts nothing that is not verified", async () => {
    const { ValueRecords } = await withRecords([
      { input: profitRecord({ amountCents: 40_000_000 }), verified: false },
    ]);
    const summary = await ValueRecords.summary("2026-09");
    expect(summary.verified.recurringCents).toBe(0);
    expect(summary.unverified.pendingCents).toBe(40_000_000);
    expect(summary.status).toBe("below_90x");
  });

  it("excludes one-time recoveries from the recurring multiple", async () => {
    const { ValueRecords } = await withRecords([
      {
        input: profitRecord({ amountCents: 40_000_000, recurring: false, sourceReference: "one-off" }),
        verified: true,
      },
    ]);
    const summary = await ValueRecords.summary("2026-09");
    expect(summary.verified.oneTimeCents).toBe(40_000_000);
    expect(summary.verified.recurringCents).toBe(0);
    expect(summary.status).toBe("below_90x");
  });

  it("reports 90x qualified only at or above the 90x threshold", async () => {
    const { ValueRecords } = await withRecords([
      { input: profitRecord({ amountCents: 34_999_920 }), verified: true },
    ]);
    const summary = await ValueRecords.summary("2026-09");
    expect(summary.multiple).toBe(90);
    expect(summary.status).toBe("qualified_90x");
  });

  it("reports 100x qualified at the 100x threshold", async () => {
    const { ValueRecords } = await withRecords([
      { input: profitRecord({ amountCents: 38_888_800 }), verified: true },
    ]);
    const summary = await ValueRecords.summary("2026-09");
    expect(summary.multiple).toBe(100);
    expect(summary.status).toBe("qualified_100x");
  });

  it("computes net ROI separately from the raw multiple", async () => {
    const { ValueRecords } = await withRecords([
      { input: profitRecord({ amountCents: FEE_CENTS * 10 }), verified: true },
    ]);
    const summary = await ValueRecords.summary("2026-09");
    expect(summary.multiple).toBe(10);
    // (benefit - fee) / fee
    expect(summary.netRoi).toBe(9);
  });

  it("states the shortfall to each threshold", async () => {
    const { ValueRecords } = await withRecords([
      { input: profitRecord({ amountCents: 10_000_000 }), verified: true },
    ]);
    const summary = await ValueRecords.summary("2026-09");
    expect(summary.shortfall.to90xCents).toBe(34_999_920 - 10_000_000);
    expect(summary.shortfall.to100xCents).toBe(38_888_800 - 10_000_000);
  });
});

describe("prospect calculator", () => {
  it("states the additional sales needed, and labels it an assumption", () => {
    const db = makeDb();
    const { ValueRecords } = load(db);
    const scenarios = ValueRecords.qualificationScenarios({
      grossProfitPerSaleCents: 1_000_000, // $10,000
    });
    // $388,888 / $10,000 = 38.9 -> 39 sales
    expect(scenarios.scenarios.additionalSales.for100x).toBe(39);
    expect(scenarios.scenarios.additionalSales.for90x).toBe(35);
    expect(scenarios.isAssumption).toBe(true);
    expect(scenarios.note).toMatch(/not measured results/i);
  });

  it("returns thresholds even with no assumptions supplied", () => {
    const db = makeDb();
    const { ValueRecords } = load(db);
    const scenarios = ValueRecords.qualificationScenarios();
    expect(scenarios.requiredCents.x100).toBe(38_888_800);
    expect(scenarios.scenarios).toEqual({});
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

  it("recomputes the thresholds when the plan amount changes", async () => {
    const db = makeDb();
    jest.resetModules();
    process.env.PLAN_AMOUNT_CENTS = "500000";
    jest.doMock("../../utils/prisma", () => db.client);
    const { ValueRecords } = require("../../business/models/value");
    const summary = await ValueRecords.summary("2026-09");
    expect(summary.fee.monthlyCents).toBe(500000);
    expect(summary.thresholds.x100.requiredCents).toBe(50_000_000);
  });
});

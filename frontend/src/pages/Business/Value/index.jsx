import React, { useEffect, useState } from "react";
import Sidebar from "@/components/SettingsSidebar";
import { isMobile } from "react-device-detect";
import Business from "@/models/business";
import BusinessPage, {
  Button,
  Badge,
  Card,
  Table,
  Stat,
  EmptyState,
} from "@/components/Business/Layout";
import { Modal } from "../Agents";
import showToast from "@/utils/toast";

/**
 * Value.
 *
 * This page exists to make the commercial claim falsifiable. Verified
 * recurring value is the only figure that moves the verdict; pending records
 * and one-time recoveries are shown separately and never counted. The words
 * "qualified", "proven" and "guaranteed" appear only where verified records
 * support them.
 */

const STATUS_PRESENTATION = {
  below_90x: { tone: "neutral", label: "Below 90x on verified evidence" },
  qualified_90x: {
    tone: "success",
    label: "90x qualified on verified evidence",
  },
  qualified_100x: {
    tone: "success",
    label: "100x qualified on verified evidence",
  },
};

function money(cents, currency = "USD") {
  if (cents === null || cents === undefined) return "—";
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)}`;
  }
}

function thisMonth() {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

export default function ValuePage() {
  const [period, setPeriod] = useState(thisMonth());
  const [summary, setSummary] = useState(null);
  const [records, setRecords] = useState([]);
  const [categories, setCategories] = useState({});
  const [capabilities, setCapabilities] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [adding, setAdding] = useState(false);
  const [calculator, setCalculator] = useState(false);

  async function load() {
    setLoading(true);
    const [summaryResult, recordResult, me] = await Promise.all([
      Business.value.summary(period),
      Business.value.records({ period }),
      Business.me(),
    ]);
    if (summaryResult?.error) setError(summaryResult.error);
    else setSummary(summaryResult.summary);
    setRecords(recordResult?.records ?? []);
    setCategories(recordResult?.categories ?? summaryResult?.categories ?? {});
    setCapabilities(me?.capabilities ?? []);
    setLoading(false);
  }

  useEffect(() => {
    load();
  }, [period]);

  const canManage = capabilities.includes("settings:manage");
  const canVerify = capabilities.includes("billing:view");
  const presentation =
    STATUS_PRESENTATION[summary?.status] ?? STATUS_PRESENTATION.below_90x;

  return (
    <div className="w-screen h-screen overflow-hidden bg-theme-bg-container flex">
      <Sidebar />
      <div
        style={{ height: isMobile ? "100%" : "calc(100% - 32px)" }}
        className="relative md:ml-[2px] md:mr-[16px] md:my-[16px] md:rounded-[16px] bg-theme-bg-secondary w-full h-full overflow-y-scroll"
      >
        <BusinessPage
          title="Value"
          description="Measured business value delivered by the platform. Only records verified against evidence count toward qualification."
          loading={loading}
          error={error}
          actions={
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="month"
                value={period}
                onChange={(e) => setPeriod(e.target.value)}
                className="rounded-lg border border-theme-modal-border bg-theme-bg-primary px-3 py-2 text-sm text-theme-text-primary"
              />
              <Button variant="secondary" onClick={() => setCalculator(true)}>
                Qualification calculator
              </Button>
              <Button
                variant="secondary"
                onClick={() => Business.value.exportCsv(period)}
              >
                Export CSV
              </Button>
              {canManage && (
                <Button onClick={() => setAdding(true)}>Record value</Button>
              )}
            </div>
          }
        >
          {summary && (
            <>
              <Card>
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div>
                    <p className="text-xs uppercase tracking-wide text-theme-text-secondary">
                      Verified recurring value this month
                    </p>
                    <p className="mt-1 text-3xl font-semibold text-theme-text-primary">
                      {money(summary.verified.recurringCents)}
                    </p>
                    <p className="mt-1 text-sm text-theme-text-secondary">
                      {summary.multiple}x the {summary.fee.display} platform fee
                    </p>
                  </div>
                  <Badge tone={presentation.tone}>{presentation.label}</Badge>
                </div>

                <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-3">
                  <Threshold
                    label="90x threshold"
                    requiredCents={summary.thresholds.x90.requiredCents}
                    achievedCents={summary.verified.recurringCents}
                    shortfallCents={summary.shortfall.to90xCents}
                  />
                  <Threshold
                    label="100x threshold"
                    requiredCents={summary.thresholds.x100.requiredCents}
                    achievedCents={summary.verified.recurringCents}
                    shortfallCents={summary.shortfall.to100xCents}
                  />
                  <div className="rounded-xl border border-theme-modal-border bg-theme-bg-primary p-4">
                    <p className="text-xs uppercase tracking-wide text-theme-text-secondary">
                      Net ROI
                    </p>
                    <p className="mt-1 text-2xl font-semibold text-theme-text-primary">
                      {summary.netRoi}x
                    </p>
                    <p className="mt-1 text-xs text-theme-text-secondary">
                      (verified value − fee) ÷ fee
                    </p>
                  </div>
                </div>
              </Card>

              <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
                <Stat
                  label="Verified records"
                  value={summary.verified.recordCount}
                  hint="counted"
                />
                <Stat
                  label="Awaiting verification"
                  value={money(summary.unverified.pendingCents)}
                  hint={`${summary.unverified.recordCount} record(s) — not counted`}
                />
                <Stat
                  label="One-time recoveries"
                  value={money(summary.verified.oneTimeCents)}
                  hint="excluded from the monthly multiple"
                />
                <Stat label="Platform fee" value={summary.fee.display} />
              </div>

              {summary.unverified.recordCount > 0 && (
                <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-300">
                  {summary.unverified.recordCount} record(s) worth{" "}
                  {money(summary.unverified.pendingCents)} are awaiting
                  verification. They do not count toward the figures above until
                  someone other than their author confirms them against
                  evidence.
                </div>
              )}
            </>
          )}

          {!records.length ? (
            <EmptyState
              title="No value recorded for this month"
              description="Record gross profit on deals the platform is credited with, or costs avoided against an approved baseline. A captured lead is not revenue and cannot be recorded as one."
              action={
                canManage ? (
                  <Button onClick={() => setAdding(true)}>Record value</Button>
                ) : null
              }
            />
          ) : (
            <Card title={`Records (${records.length})`}>
              <Table
                columns={[
                  {
                    key: "category",
                    label: "What",
                    render: (r) => (
                      <div>
                        <p className="font-medium">
                          {categories[r.category]?.label ?? r.category}
                        </p>
                        <p className="text-xs text-theme-text-secondary line-clamp-1">
                          {r.description ?? "—"}
                        </p>
                      </div>
                    ),
                  },
                  {
                    key: "amount_cents",
                    label: "Amount",
                    render: (r) => (
                      <div>
                        <p className="font-medium">
                          {money(
                            r.amount_cents,
                            (r.currency ?? "usd").toUpperCase()
                          )}
                        </p>
                        {!r.recurring && (
                          <p className="text-xs text-theme-text-secondary">
                            one-time
                          </p>
                        )}
                      </div>
                    ),
                  },
                  {
                    key: "evidence_ref",
                    label: "Evidence",
                    render: (r) => (
                      <span className="text-xs">
                        {r.evidence_ref ?? (
                          <span className="text-amber-400">none recorded</span>
                        )}
                        {r.baseline_cents !== null &&
                          r.baseline_cents !== undefined && (
                            <span className="block text-theme-text-secondary">
                              baseline {money(r.baseline_cents)} →{" "}
                              {money(r.measured_cents)}
                            </span>
                          )}
                      </span>
                    ),
                  },
                  {
                    key: "verification",
                    label: "Verification",
                    render: (r) => (
                      <Badge
                        tone={
                          r.verification === "verified"
                            ? "success"
                            : r.verification === "rejected"
                              ? "danger"
                              : "warning"
                        }
                      >
                        {r.verification}
                      </Badge>
                    ),
                  },
                  {
                    key: "actions",
                    label: "",
                    render: (r) => (
                      <div className="flex gap-3">
                        {canVerify && r.verification !== "verified" && (
                          <button
                            type="button"
                            onClick={() => setVerification(r.uuid, "verified")}
                            className="text-xs underline text-theme-text-secondary hover:text-theme-text-primary"
                          >
                            Verify
                          </button>
                        )}
                        {canVerify && r.verification === "pending" && (
                          <button
                            type="button"
                            onClick={() => setVerification(r.uuid, "rejected")}
                            className="text-xs underline text-theme-text-secondary hover:text-theme-text-primary"
                          >
                            Reject
                          </button>
                        )}
                        {canManage && (
                          <button
                            type="button"
                            onClick={async () => {
                              if (!window.confirm("Remove this value record?"))
                                return;
                              const result = await Business.value.remove(
                                r.uuid
                              );
                              if (result?.error)
                                return showToast(result.error, "error");
                              load();
                            }}
                            className="text-xs underline text-red-400"
                          >
                            Remove
                          </button>
                        )}
                      </div>
                    ),
                  },
                ]}
                rows={records}
              />
            </Card>
          )}

          <p className="text-xs text-theme-text-secondary">
            Only verified, recurring records count toward the 90x and 100x
            figures. A captured lead is never counted as revenue; revenue counts
            only as realized gross profit on a confirmed conversion, and an
            avoided cost only against a customer-approved baseline with a
            measured result.
          </p>

          {adding && (
            <RecordValue
              categories={categories}
              period={period}
              onClose={() => setAdding(false)}
              onCreated={() => {
                setAdding(false);
                load();
              }}
            />
          )}

          {calculator && <Calculator onClose={() => setCalculator(false)} />}
        </BusinessPage>
      </div>
    </div>
  );

  async function setVerification(uuid, verification) {
    const result = await Business.value.setVerification(uuid, verification);
    if (!result?.success)
      return showToast(result?.error ?? "Could not update.", "error");
    showToast(`Record ${verification}.`, "success");
    load();
  }
}

function Threshold({ label, requiredCents, achievedCents, shortfallCents }) {
  const met = shortfallCents === 0;
  const percent = requiredCents
    ? Math.min(100, Math.round((achievedCents / requiredCents) * 100))
    : 0;
  return (
    <div className="rounded-xl border border-theme-modal-border bg-theme-bg-primary p-4">
      <div className="flex items-center justify-between">
        <p className="text-xs uppercase tracking-wide text-theme-text-secondary">
          {label}
        </p>
        {met && <Badge tone="success">met</Badge>}
      </div>
      <p className="mt-1 text-lg font-semibold text-theme-text-primary">
        {money(requiredCents)}
      </p>
      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-theme-bg-secondary">
        <div
          className={`h-full rounded-full ${met ? "bg-green-500" : "bg-blue-500"}`}
          style={{ width: `${percent}%` }}
        />
      </div>
      <p className="mt-1 text-xs text-theme-text-secondary">
        {met
          ? "Threshold met on verified evidence"
          : `${money(shortfallCents)} short`}
      </p>
    </div>
  );
}

function RecordValue({ categories, period, onClose, onCreated }) {
  const [form, setForm] = useState({
    category: Object.keys(categories)[0] ?? "closed_won_revenue",
    period,
    amount: "",
    recurring: true,
    description: "",
    evidenceRef: "",
    sourceSystem: "",
    sourceReference: "",
    baseline: "",
    measured: "",
    baselineApprovedBy: "",
  });
  const [saving, setSaving] = useState(false);

  const spec = categories[form.category] ?? {};
  const isAvoidedCost = spec.kind === "avoided_cost";

  async function submit() {
    const amountCents = Math.round(Number(form.amount) * 100);
    if (!Number.isFinite(amountCents) || amountCents <= 0)
      return showToast("Enter a positive amount.", "error");

    setSaving(true);
    const result = await Business.value.create({
      category: form.category,
      period: form.period,
      amountCents,
      recurring: form.recurring,
      description: form.description,
      evidenceRef: form.evidenceRef,
      sourceSystem: form.sourceSystem,
      sourceReference: form.sourceReference,
      ...(isAvoidedCost
        ? {
            baselineCents: Math.round(Number(form.baseline) * 100),
            measuredCents: Math.round(Number(form.measured) * 100),
            baselineApprovedBy: form.baselineApprovedBy,
          }
        : {}),
    });
    setSaving(false);
    if (result?.error) return showToast(result.error, "error");
    showToast("Recorded. It counts once someone else verifies it.", "success");
    onCreated();
  }

  return (
    <Modal title="Record delivered value" onClose={onClose} wide>
      <label className="block text-sm">
        <span className="text-theme-text-secondary">What kind of value?</span>
        <select
          value={form.category}
          onChange={(e) => setForm({ ...form, category: e.target.value })}
          className="mt-1 w-full rounded-lg border border-theme-modal-border bg-theme-bg-primary px-3 py-2 text-theme-text-primary"
        >
          {Object.entries(categories).map(([key, value]) => (
            <option key={key} value={key}>
              {value.label}
            </option>
          ))}
        </select>
        {spec.help && (
          <span className="mt-1 block text-xs text-theme-text-secondary">
            {spec.help}
          </span>
        )}
      </label>

      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Field
          label="Amount"
          value={form.amount}
          onChange={(v) => setForm({ ...form, amount: v })}
          placeholder="10000.00"
          type="number"
        />
        <Field
          label="Month"
          value={form.period}
          onChange={(v) => setForm({ ...form, period: v })}
          type="month"
        />
        <label className="flex items-end gap-2 pb-2 text-sm text-theme-text-primary">
          <input
            type="checkbox"
            checked={form.recurring}
            onChange={(e) => setForm({ ...form, recurring: e.target.checked })}
            className="h-4 w-4"
          />
          Recurring monthly
        </label>
      </div>

      {isAvoidedCost && (
        <div className="mt-4 rounded-lg border border-theme-modal-border p-3">
          <p className="text-xs text-theme-text-secondary">
            An avoided cost needs a customer-approved baseline and a measured
            result. Without both, it is an estimate and will be refused.
          </p>
          <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field
              label="Approved baseline"
              value={form.baseline}
              onChange={(v) => setForm({ ...form, baseline: v })}
              type="number"
            />
            <Field
              label="Measured after"
              value={form.measured}
              onChange={(v) => setForm({ ...form, measured: v })}
              type="number"
            />
            <Field
              label="Baseline approved by"
              value={form.baselineApprovedBy}
              onChange={(v) => setForm({ ...form, baselineApprovedBy: v })}
              placeholder="Name and role"
            />
          </div>
        </div>
      )}

      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Field
          label="Evidence reference"
          value={form.evidenceRef}
          onChange={(v) => setForm({ ...form, evidenceRef: v })}
          placeholder="INV-1001"
        />
        <Field
          label="Source system"
          value={form.sourceSystem}
          onChange={(v) => setForm({ ...form, sourceSystem: v })}
          placeholder="crm"
        />
        <Field
          label="Source reference"
          value={form.sourceReference}
          onChange={(v) => setForm({ ...form, sourceReference: v })}
          placeholder="opportunity id"
        />
      </div>

      <label className="mt-4 block text-sm">
        <span className="text-theme-text-secondary">Description</span>
        <textarea
          rows={3}
          value={form.description}
          onChange={(e) => setForm({ ...form, description: e.target.value })}
          className="mt-1 w-full rounded-lg border border-theme-modal-border bg-theme-bg-primary px-3 py-2 text-theme-text-primary"
        />
      </label>

      <div className="mt-6 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={submit} disabled={saving}>
          {saving ? "Saving…" : "Record"}
        </Button>
      </div>
    </Modal>
  );
}

function Calculator({ onClose }) {
  const [profitPerSale, setProfitPerSale] = useState("10000");
  const [result, setResult] = useState(null);

  async function compute() {
    const cents = Math.round(Number(profitPerSale) * 100);
    const data = await Business.value.scenarios({
      grossProfitPerSaleCents: cents,
    });
    setResult(data?.error ? null : data);
  }

  useEffect(() => {
    compute();
  }, []);

  return (
    <Modal title="Qualification calculator" onClose={onClose}>
      <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
        These are assumptions for discussion, not measured results. Only
        verified records on the Value page count toward qualification.
      </div>

      <label className="mt-4 block text-sm">
        <span className="text-theme-text-secondary">
          Confirmed gross profit per additional sale
        </span>
        <div className="mt-1 flex gap-2">
          <input
            type="number"
            value={profitPerSale}
            onChange={(e) => setProfitPerSale(e.target.value)}
            className="flex-1 rounded-lg border border-theme-modal-border bg-theme-bg-primary px-3 py-2 text-theme-text-primary"
          />
          <Button variant="secondary" onClick={compute}>
            Calculate
          </Button>
        </div>
      </label>

      {result && (
        <div className="mt-4 space-y-3">
          <Row label="Monthly platform fee" value={money(result.feeCents)} />
          <Row label="90x requires" value={money(result.requiredCents.x90)} />
          <Row label="100x requires" value={money(result.requiredCents.x100)} />
          {result.scenarios?.additionalSales && (
            <>
              <Row
                label="Additional sales per month for 90x"
                value={`${result.scenarios.additionalSales.for90x}`}
              />
              <Row
                label="Additional sales per month for 100x"
                value={`${result.scenarios.additionalSales.for100x}`}
              />
            </>
          )}
        </div>
      )}
    </Modal>
  );
}

function Row({ label, value }) {
  return (
    <div className="flex items-center justify-between border-b border-theme-modal-border/50 pb-2 text-sm">
      <span className="text-theme-text-secondary">{label}</span>
      <span className="font-medium text-theme-text-primary">{value}</span>
    </div>
  );
}

function Field({ label, value, onChange, placeholder = "", type = "text" }) {
  return (
    <label className="block text-sm">
      <span className="text-theme-text-secondary">{label}</span>
      <input
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full rounded-lg border border-theme-modal-border bg-theme-bg-primary px-3 py-2 text-theme-text-primary"
      />
    </label>
  );
}

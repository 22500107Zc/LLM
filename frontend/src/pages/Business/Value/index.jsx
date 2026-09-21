import React, { useCallback, useEffect, useMemo, useState } from "react";
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
 * Return on subscription.
 *
 * The number here is the customer's own return, and it moves as their inputs
 * move. There is no target to reach and nothing to qualify for: 30x and 82x
 * are ordinary results, and so is 0.4x.
 *
 *   monthly benefit = recurring cost savings + attributable gross profit
 *   return multiple = monthly benefit / subscription fee
 *   net value       = monthly benefit - subscription fee
 *   net ROI         = ((monthly benefit - fee) / fee) x 100
 *
 * A record counts as soon as it is recorded, so nobody has to wait for a
 * second person to see the effect of their own input. When the headline
 * includes anything unverified it says so, and the verified portion stays
 * visible on its own.
 */

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

/** Multiples read naturally: 30x, 82.5x, 0.42x. */
function multipleLabel(value) {
  if (value === null || value === undefined) return "—";
  const rounded = Math.round(value * 100) / 100;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(2)}x`;
}

function percentLabel(value) {
  if (value === null || value === undefined) return "—";
  const rounded = Math.round(value * 100) / 100;
  return `${rounded > 0 ? "+" : ""}${rounded.toLocaleString(undefined, {
    maximumFractionDigits: 2,
  })}%`;
}

/**
 * The same arithmetic the server uses, so a draft can be previewed without a
 * round trip. A missing or zero fee yields nulls, never Infinity or NaN.
 */
export function computeReturn(benefitCents, feeCents) {
  const benefit = Number.isFinite(Number(benefitCents))
    ? Math.round(Number(benefitCents))
    : 0;
  const fee =
    Number.isFinite(Number(feeCents)) && Number(feeCents) > 0
      ? Math.round(Number(feeCents))
      : 0;
  if (fee <= 0)
    return {
      monthlyBenefitCents: benefit,
      returnMultiple: null,
      netValueCents: null,
      netRoiPercent: null,
    };
  const netValueCents = benefit - fee;
  return {
    monthlyBenefitCents: benefit,
    returnMultiple: Math.round((benefit / fee) * 100) / 100,
    netValueCents,
    netRoiPercent: Math.round((netValueCents / fee) * 100 * 100) / 100,
  };
}

function thisMonth() {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

function centsFrom(input) {
  const number = Number(input);
  if (!Number.isFinite(number)) return 0;
  return Math.round(number * 100);
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
  const [editing, setEditing] = useState(null);
  const [calculator, setCalculator] = useState(false);

  /**
   * Reloading is the single path back to a correct number, so every mutation
   * — save, edit, remove, verify, reject — and every month change ends here.
   */
  const load = useCallback(async () => {
    setLoading(true);
    const [summaryResult, recordResult, me] = await Promise.all([
      Business.value.summary(period),
      Business.value.records({ period }),
      Business.me(),
    ]);
    if (summaryResult?.error) setError(summaryResult.error);
    else {
      setError(null);
      setSummary(summaryResult.summary);
    }
    setRecords(recordResult?.records ?? []);
    setCategories(recordResult?.categories ?? summaryResult?.categories ?? {});
    setCapabilities(me?.capabilities ?? []);
    setLoading(false);
  }, [period]);

  useEffect(() => {
    load();
  }, [load]);

  const canManage = capabilities.includes("settings:manage");
  const canVerify = capabilities.includes("billing:view");
  const currency = (summary?.currency ?? "usd").toUpperCase();

  async function setVerification(uuid, verification) {
    const result = await Business.value.setVerification(uuid, verification);
    if (!result?.success)
      return showToast(result?.error ?? "Could not update.", "error");
    showToast(`Record ${verification}.`, "success");
    load();
  }

  async function remove(uuid) {
    if (!window.confirm("Remove this value record?")) return;
    const result = await Business.value.remove(uuid);
    if (result?.error) return showToast(result.error, "error");
    showToast("Record removed.", "success");
    load();
  }

  return (
    <div className="w-screen h-screen overflow-hidden bg-theme-bg-container flex">
      <Sidebar />
      <div
        style={{ height: isMobile ? "100%" : "calc(100% - 32px)" }}
        className="relative md:ml-[2px] md:mr-[16px] md:my-[16px] md:rounded-[16px] bg-theme-bg-secondary w-full h-full overflow-y-scroll"
      >
        <BusinessPage
          title="Value"
          description="What the platform returned this month against what it costs."
          loading={loading}
          error={error}
          actions={
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="month"
                value={period}
                onChange={(e) => setPeriod(e.target.value)}
                aria-label="Reporting month"
                className="rounded-lg border border-theme-modal-border bg-theme-bg-primary px-3 py-2 text-sm text-theme-text-primary"
              />
              <Button variant="secondary" onClick={() => setCalculator(true)}>
                Estimate value
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
          {summary && <Headline summary={summary} currency={currency} />}

          {summary && summary.hasInput && (
            <Breakdown summary={summary} currency={currency} />
          )}

          {!records.length ? (
            <EmptyState
              title="Nothing recorded for this month yet"
              description="Record gross profit on deals the platform is credited with, or costs avoided against an approved baseline. Your return appears as soon as you add the first one. A captured lead is not revenue and cannot be recorded as one."
              action={
                canManage ? (
                  <Button onClick={() => setAdding(true)}>Record value</Button>
                ) : null
              }
            />
          ) : (
            <Card title={`Records (${records.length})`}>
              <Table
                columns={recordColumns({
                  categories,
                  canManage,
                  canVerify,
                  onEdit: setEditing,
                  onVerify: setVerification,
                  onRemove: remove,
                })}
                rows={records}
              />
            </Card>
          )}

          {adding && (
            <RecordValue
              categories={categories}
              period={period}
              feeCents={summary?.fee?.monthlyCents ?? 0}
              currency={currency}
              currentBenefitCents={summary?.monthlyBenefitCents ?? 0}
              onClose={() => setAdding(false)}
              onSaved={() => {
                setAdding(false);
                load();
              }}
            />
          )}

          {editing && (
            <EditValue
              record={editing}
              categories={categories}
              feeCents={summary?.fee?.monthlyCents ?? 0}
              currency={currency}
              currentBenefitCents={summary?.monthlyBenefitCents ?? 0}
              onClose={() => setEditing(null)}
              onSaved={() => {
                setEditing(null);
                load();
              }}
            />
          )}

          {calculator && (
            <EstimateValue
              period={period}
              currency={currency}
              onClose={() => setCalculator(false)}
            />
          )}
        </BusinessPage>
      </div>
    </div>
  );
}

/** The one number the page is for, and the three that explain it. */
function Headline({ summary, currency }) {
  const {
    returnMultiple,
    monthlyBenefitCents,
    netValueCents,
    netRoiPercent,
    includesEstimates,
    headlineLabel,
    fee,
    feeAvailable,
  } = summary;

  const belowCost = netValueCents !== null && netValueCents < 0;

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs uppercase tracking-wide text-theme-text-secondary">
            {headlineLabel}
          </p>
          <p className="mt-1 text-4xl font-semibold text-theme-text-primary">
            {feeAvailable ? multipleLabel(returnMultiple) : "—"}
          </p>
          <p className="mt-1 text-sm text-theme-text-secondary">
            {feeAvailable
              ? `${money(monthlyBenefitCents, currency)} recorded benefit against a ${fee.display} subscription`
              : "Set a subscription fee to see a return multiple."}
          </p>
        </div>
        {includesEstimates && (
          <Badge tone="neutral">Includes unverified estimates</Badge>
        )}
      </div>

      <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Figure
          label="Recorded benefit"
          value={money(monthlyBenefitCents, currency)}
          hint="recurring savings + gross profit this month"
        />
        <Figure
          label="Subscription cost"
          value={fee.display}
          hint={
            fee.isAssumption ? "assumed fee — see note below" : "this month"
          }
        />
        <Figure
          label="Net value after subscription"
          value={netValueCents === null ? "—" : money(netValueCents, currency)}
          hint={
            netRoiPercent === null
              ? "needs a subscription fee"
              : `net ROI ${percentLabel(netRoiPercent)}`
          }
          tone={belowCost ? "negative" : "normal"}
        />
      </div>

      {belowCost && (
        <p className="mt-3 text-xs text-theme-text-secondary">
          Recorded benefit is below the subscription cost this month.
        </p>
      )}

      {includesEstimates && (
        <p className="mt-3 text-xs text-theme-text-secondary">
          {summary.headlineNote} Verified only:{" "}
          <span className="text-theme-text-primary">
            {multipleLabel(summary.verifiedOnly.returnMultiple)}
          </span>{" "}
          on {money(summary.verifiedOnly.monthlyBenefitCents, currency)}.
        </p>
      )}

      {fee.note && (
        <p className="mt-2 text-xs text-theme-text-secondary">{fee.note}</p>
      )}
    </Card>
  );
}

/** Where the number came from, and what was deliberately left out of it. */
function Breakdown({ summary, currency }) {
  const { breakdown, recorded, verified, pending, otherCurrencies } = summary;
  return (
    <>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat
          label="Gross profit"
          value={money(breakdown.recorded.gross_profit, currency)}
          hint="attributed to the platform"
        />
        <Stat
          label="Cash costs avoided"
          value={money(breakdown.recorded.cash_saving, currency)}
          hint="spending that stopped"
        />
        <Stat
          label="Time valued"
          value={money(breakdown.recorded.time_valued, currency)}
          hint="hours costed at an agreed rate, not cash"
        />
        <Stat
          label="One-time recoveries"
          value={money(recorded.oneTimeCents, currency)}
          hint="counted once, not repeated monthly"
        />
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat
          label="Verified"
          value={money(verified.recurringCents, currency)}
          hint={`${verified.recordCount} record(s) confirmed against evidence`}
        />
        <Stat
          label="Awaiting verification"
          value={money(pending.recurringCents, currency)}
          hint={`${pending.recordCount} record(s) — counted as estimates`}
        />
        <Stat
          label="Rejected"
          value={summary.rejected.recordCount}
          hint="excluded from every figure"
        />
        <Stat
          label="Other currencies"
          value={otherCurrencies.recordCount}
          hint={
            otherCurrencies.recordCount
              ? `${otherCurrencies.currencies.join(", ").toUpperCase()} — listed, not added`
              : "none"
          }
        />
      </div>
    </>
  );
}

function Figure({ label, value, hint, tone = "normal" }) {
  return (
    <div className="rounded-xl border border-theme-modal-border bg-theme-bg-primary p-4">
      <p className="text-xs uppercase tracking-wide text-theme-text-secondary">
        {label}
      </p>
      <p
        className={`mt-1 text-2xl font-semibold ${
          tone === "negative" ? "text-red-400" : "text-theme-text-primary"
        }`}
      >
        {value}
      </p>
      <p className="mt-1 text-xs text-theme-text-secondary">{hint}</p>
    </div>
  );
}

function recordColumns({
  categories,
  canManage,
  canVerify,
  onEdit,
  onVerify,
  onRemove,
}) {
  return [
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
            {money(r.amount_cents, (r.currency ?? "usd").toUpperCase())}
          </p>
          {!r.recurring && (
            <p className="text-xs text-theme-text-secondary">one-time</p>
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
            <span className="text-theme-text-secondary">none recorded</span>
          )}
          {r.baseline_cents !== null && r.baseline_cents !== undefined && (
            <span className="block text-theme-text-secondary">
              baseline {money(r.baseline_cents)} → {money(r.measured_cents)}
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
                : "neutral"
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
        <div className="flex flex-wrap gap-3">
          {canManage && (
            <button
              type="button"
              onClick={() => onEdit(r)}
              className="text-xs underline text-theme-text-secondary hover:text-theme-text-primary"
            >
              Edit
            </button>
          )}
          {canVerify && r.verification !== "verified" && (
            <button
              type="button"
              onClick={() => onVerify(r.uuid, "verified")}
              className="text-xs underline text-theme-text-secondary hover:text-theme-text-primary"
            >
              Verify
            </button>
          )}
          {canVerify && r.verification !== "rejected" && (
            <button
              type="button"
              onClick={() => onVerify(r.uuid, "rejected")}
              className="text-xs underline text-theme-text-secondary hover:text-theme-text-primary"
            >
              Reject
            </button>
          )}
          {canManage && (
            <button
              type="button"
              onClick={() => onRemove(r.uuid)}
              className="text-xs underline text-red-400"
            >
              Remove
            </button>
          )}
        </div>
      ),
    },
  ];
}

/**
 * Live preview of what a draft would do to the month's return.
 *
 * Deliberately marked unsaved: it is arithmetic on what has been typed, and
 * nothing is persisted until Save is pressed.
 */
function LivePreview({
  currentBenefitCents,
  draftCents,
  feeCents,
  currency,
  recurring,
}) {
  const before = computeReturn(currentBenefitCents, feeCents);
  const after = computeReturn(
    currentBenefitCents + (recurring ? draftCents : 0),
    feeCents
  );

  return (
    <div className="mt-4 rounded-lg border border-dashed border-theme-modal-border bg-theme-bg-primary px-4 py-3">
      <div className="flex items-center justify-between">
        <p className="text-xs uppercase tracking-wide text-theme-text-secondary">
          Preview — not saved
        </p>
        <Badge tone="neutral">unsaved</Badge>
      </div>
      <div className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-sm text-theme-text-secondary">
          {multipleLabel(before.returnMultiple)}
        </span>
        <span className="text-theme-text-secondary">→</span>
        <span className="text-2xl font-semibold text-theme-text-primary">
          {multipleLabel(after.returnMultiple)}
        </span>
        <span className="text-xs text-theme-text-secondary">
          {money(after.monthlyBenefitCents, currency)} benefit ·{" "}
          {after.netValueCents === null
            ? "no fee set"
            : `${money(after.netValueCents, currency)} net`}
        </span>
      </div>
      {!recurring && draftCents > 0 && (
        <p className="mt-1 text-xs text-theme-text-secondary">
          A one-time amount is recorded and shown separately; it does not change
          the monthly multiple.
        </p>
      )}
    </div>
  );
}

function RecordValue({
  categories,
  period,
  feeCents,
  currency,
  currentBenefitCents,
  onClose,
  onSaved,
}) {
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
  const draftCents = useMemo(() => centsFrom(form.amount), [form.amount]);

  async function submit() {
    if (draftCents <= 0) return showToast("Enter a positive amount.", "error");

    setSaving(true);
    const result = await Business.value.create({
      category: form.category,
      period: form.period,
      amountCents: draftCents,
      recurring: form.recurring,
      description: form.description,
      evidenceRef: form.evidenceRef,
      sourceSystem: form.sourceSystem,
      sourceReference: form.sourceReference,
      ...(isAvoidedCost
        ? {
            baselineCents: centsFrom(form.baseline),
            measuredCents: centsFrom(form.measured),
            baselineApprovedBy: form.baselineApprovedBy,
          }
        : {}),
    });
    setSaving(false);
    if (result?.error) return showToast(result.error, "error");
    showToast("Recorded.", "success");
    onSaved();
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

      <LivePreview
        currentBenefitCents={currentBenefitCents}
        draftCents={draftCents}
        feeCents={feeCents}
        currency={currency}
        recurring={form.recurring}
      />

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
          {saving ? "Saving…" : "Save record"}
        </Button>
      </div>
    </Modal>
  );
}

/**
 * Editing the figures a customer most often gets wrong. Category is fixed at
 * creation, because changing it would change which rules were ever applied.
 */
function EditValue({
  record,
  categories,
  feeCents,
  currency,
  currentBenefitCents,
  onClose,
  onSaved,
}) {
  const [form, setForm] = useState({
    amount: ((record.amount_cents ?? 0) / 100).toString(),
    period: record.period ?? thisMonth(),
    recurring: record.recurring !== false,
    description: record.description ?? "",
    evidenceRef: record.evidence_ref ?? "",
    baseline:
      record.baseline_cents === null || record.baseline_cents === undefined
        ? ""
        : (record.baseline_cents / 100).toString(),
    measured:
      record.measured_cents === null || record.measured_cents === undefined
        ? ""
        : (record.measured_cents / 100).toString(),
    baselineApprovedBy: record.baseline_approved_by ?? "",
  });
  const [saving, setSaving] = useState(false);

  const spec = categories[record.category] ?? {};
  const isAvoidedCost = spec.kind === "avoided_cost";
  const draftCents = useMemo(() => centsFrom(form.amount), [form.amount]);

  // The record's own current contribution is removed from the baseline so the
  // preview shows the month as it would be after the edit, not on top of it.
  const othersBenefitCents =
    currentBenefitCents -
    (record.recurring !== false ? (record.amount_cents ?? 0) : 0);

  async function submit() {
    if (draftCents <= 0) return showToast("Enter a positive amount.", "error");
    setSaving(true);
    const result = await Business.value.update(record.uuid, {
      amountCents: draftCents,
      period: form.period,
      recurring: form.recurring,
      description: form.description,
      evidenceRef: form.evidenceRef,
      ...(isAvoidedCost
        ? {
            baselineCents: centsFrom(form.baseline),
            measuredCents: centsFrom(form.measured),
            baselineApprovedBy: form.baselineApprovedBy,
          }
        : {}),
    });
    setSaving(false);
    if (!result?.success)
      return showToast(result?.error ?? "Could not save the edit.", "error");
    showToast(
      result.reverifyRequired
        ? "Saved. The figures changed, so it needs verifying again."
        : "Saved.",
      "success"
    );
    onSaved();
  }

  return (
    <Modal title="Edit value record" onClose={onClose} wide>
      <p className="text-sm text-theme-text-secondary">
        {spec.label ?? record.category}
        {record.verification === "verified" && (
          <span className="block text-xs">
            This record is verified. Changing its figures returns it to
            unverified, because the confirmation no longer describes what is on
            it.
          </span>
        )}
      </p>

      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Field
          label="Amount"
          value={form.amount}
          onChange={(v) => setForm({ ...form, amount: v })}
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

      <LivePreview
        currentBenefitCents={othersBenefitCents}
        draftCents={draftCents}
        feeCents={feeCents}
        currency={currency}
        recurring={form.recurring}
      />

      {isAvoidedCost && (
        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
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
          />
        </div>
      )}

      <div className="mt-4">
        <Field
          label="Evidence reference"
          value={form.evidenceRef}
          onChange={(v) => setForm({ ...form, evidenceRef: v })}
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
          {saving ? "Saving…" : "Save changes"}
        </Button>
      </div>
    </Modal>
  );
}

/**
 * "Estimate value": enter savings and gross profit, see the multiple.
 *
 * It answers the customer's question and sets them no target.
 */
function EstimateValue({ period, currency, onClose }) {
  const [savings, setSavings] = useState("");
  const [profit, setProfit] = useState("");
  const [fee, setFee] = useState(null);

  useEffect(() => {
    let cancelled = false;
    Business.value.estimate({ period }).then((data) => {
      if (!cancelled && data && !data.error) setFee(data.fee ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, [period]);

  const feeCents = fee?.monthlyCents ?? 0;
  const benefitCents = centsFrom(savings) + centsFrom(profit);
  const result = computeReturn(benefitCents, feeCents);
  // Nothing entered yet is not a -100% return; it is no answer.
  const hasInput = savings.trim() !== "" || profit.trim() !== "";

  return (
    <Modal title="Estimate value" onClose={onClose}>
      <p className="text-sm text-theme-text-secondary">
        Enter what you expect in a month. Nothing here is saved or recorded.
      </p>

      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field
          label="Recurring cost savings per month"
          value={savings}
          onChange={setSavings}
          placeholder="0.00"
          type="number"
        />
        <Field
          label="Incremental gross profit per month"
          value={profit}
          onChange={setProfit}
          placeholder="0.00"
          type="number"
        />
      </div>

      <div className="mt-5 rounded-xl border border-theme-modal-border bg-theme-bg-primary p-4">
        <p className="text-xs uppercase tracking-wide text-theme-text-secondary">
          Return on subscription
        </p>
        <p className="mt-1 text-3xl font-semibold text-theme-text-primary">
          {hasInput && feeCents > 0
            ? multipleLabel(result.returnMultiple)
            : "—"}
        </p>
        {!hasInput && (
          <p className="mt-1 text-sm text-theme-text-secondary">
            Enter a figure above to see what it would come to.
          </p>
        )}
        <div className={`mt-3 space-y-2 ${hasInput ? "" : "opacity-50"}`}>
          <Row label="Monthly benefit" value={money(benefitCents, currency)} />
          <Row label="Subscription" value={fee?.display ?? "not configured"} />
          <Row
            label="Net value after subscription"
            value={
              result.netValueCents === null
                ? "—"
                : money(result.netValueCents, currency)
            }
          />
          <Row label="Net ROI" value={percentLabel(result.netRoiPercent)} />
        </div>
        {feeCents <= 0 && (
          <p className="mt-3 text-xs text-theme-text-secondary">
            No subscription fee is configured, so a multiple cannot be
            calculated.
          </p>
        )}
        {fee?.note && (
          <p className="mt-3 text-xs text-theme-text-secondary">{fee.note}</p>
        )}
      </div>
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

import React, { useEffect, useState } from "react";
import Sidebar from "@/components/SettingsSidebar";
import { isMobile } from "react-device-detect";
import Business from "@/models/business";
import BusinessPage, {
  Button,
  Badge,
  Card,
  Table,
} from "@/components/Business/Layout";
import showToast from "@/utils/toast";

/**
 * Billing.
 *
 * Every money action opens a Stripe-hosted surface. This page never collects
 * card details, and no Stripe secret is ever sent to the browser - the server
 * returns only a redirect URL.
 */

const STATUS_TONE = {
  active: "success",
  trialing: "success",
  past_due: "warning",
  payment_action_required: "warning",
  incomplete: "warning",
  unpaid: "danger",
  canceled: "danger",
  incomplete_expired: "danger",
  paused: "warning",
  unconfigured: "neutral",
};

function formatDate(value) {
  if (!value) return "—";
  try {
    return new Date(value).toLocaleDateString(undefined, {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  } catch {
    return "—";
  }
}

function formatMoney(cents, currency = "USD") {
  if (cents === null || cents === undefined) return "—";
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
    }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

export default function BillingPage() {
  const [summary, setSummary] = useState(null);
  const [invoices, setInvoices] = useState([]);
  const [priceCheck, setPriceCheck] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);

  async function load() {
    setLoading(true);
    const [summaryResult, invoiceResult] = await Promise.all([
      Business.billing.summary(),
      Business.billing.invoices(),
    ]);

    if (summaryResult?.error) setError(summaryResult.error);
    else setSummary(summaryResult);

    setInvoices(invoiceResult?.invoices ?? []);
    setLoading(false);

    // Confirms the configured Stripe price really is the commercial amount.
    // A silent mismatch would mean charging the wrong price.
    if (summaryResult?.stripe?.configured) {
      const check = await Business.billing.verifyPrice();
      if (!check?.error) setPriceCheck(check);
    }
  }

  useEffect(() => {
    load();
    // Surface the outcome of a returning Stripe Checkout redirect.
    const params = new URLSearchParams(window.location.search);
    if (params.get("checkout") === "success")
      showToast(
        "Checkout completed. Your subscription is being confirmed.",
        "success"
      );
    if (params.get("checkout") === "canceled")
      showToast("Checkout was cancelled. No payment was taken.", "info");
  }, []);

  async function act(key, fn, successMessage) {
    setBusy(key);
    const result = await fn();
    setBusy(null);

    if (result?.error) {
      showToast(result.error, "error");
      return;
    }
    if (result?.url) {
      // Hand off to Stripe's hosted surface.
      window.location.href = result.url;
      return;
    }
    if (successMessage) showToast(successMessage, "success");
    load();
  }

  const subscription = summary?.subscription;
  const access = summary?.access;
  const stripe = summary?.stripe;
  const plan = summary?.plan;

  return (
    <div className="w-screen h-screen overflow-hidden bg-theme-bg-container flex">
      <Sidebar />
      <div
        style={{ height: isMobile ? "100%" : "calc(100% - 32px)" }}
        className="relative md:ml-[2px] md:mr-[16px] md:my-[16px] md:rounded-[16px] bg-theme-bg-secondary w-full h-full overflow-y-scroll"
      >
        <BusinessPage
          title="Billing"
          description="Your subscription, payment status and invoices. Payments are handled entirely by Stripe."
          loading={loading}
          error={error}
          actions={
            <>
              <Button
                variant="secondary"
                disabled={busy !== null}
                onClick={() =>
                  act(
                    "sync",
                    () => Business.billing.sync(),
                    "Billing state refreshed."
                  )
                }
              >
                {busy === "sync" ? "Refreshing…" : "Refresh from Stripe"}
              </Button>
              <Button
                disabled={busy !== null || !stripe?.configured}
                onClick={() => act("portal", () => Business.billing.portal())}
              >
                {busy === "portal" ? "Opening…" : "Manage billing"}
              </Button>
            </>
          }
        >
          {access && access.access !== "ok" && (
            <div
              role="alert"
              className={`rounded-lg border px-4 py-3 text-sm ${
                access.access === "restricted"
                  ? "border-red-500/40 bg-red-500/10 text-red-300"
                  : "border-amber-500/40 bg-amber-500/10 text-amber-300"
              }`}
            >
              <p className="font-medium">
                {access.access === "restricted"
                  ? "AI usage is currently suspended"
                  : "Action needed on your subscription"}
              </p>
              <p className="mt-1">{access.message}</p>
              {access.graceDaysRemaining !== null &&
                access.graceDaysRemaining !== undefined && (
                  <p className="mt-1">
                    {access.graceDaysRemaining} day
                    {access.graceDaysRemaining === 1 ? "" : "s"} remaining
                    before service is suspended. Your data is always retained.
                  </p>
                )}
            </div>
          )}

          {!stripe?.configured && (
            <div className="rounded-lg border border-theme-modal-border bg-theme-bg-primary px-4 py-3 text-sm text-theme-text-secondary">
              Billing is not yet connected for this deployment. Contact your
              account manager to complete setup.
            </div>
          )}

          {priceCheck && priceCheck.verified === false && (
            <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-300">
              The Stripe price configured for this deployment does not match the
              expected {plan?.priceWithInterval}. Contact your account manager
              before taking payment.
            </div>
          )}

          <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
            <Card title="Current plan" className="lg:col-span-2">
              <div className="flex flex-wrap items-baseline justify-between gap-3">
                <div>
                  <p className="text-xl font-semibold text-theme-text-primary">
                    {plan?.name ?? "Managed Business AI Platform"}
                  </p>
                  <p className="mt-1 text-3xl font-semibold text-theme-text-primary">
                    {plan?.priceWithInterval ?? "$3,888.88/month"}
                  </p>
                  <p className="mt-1 text-xs text-theme-text-secondary">
                    Billed monthly in {plan?.currency ?? "USD"}. Your AI
                    provider charges are billed separately by your provider.
                  </p>
                </div>
                <Badge tone={STATUS_TONE[subscription?.status] ?? "neutral"}>
                  {subscription?.statusLabel ?? "Unknown"}
                </Badge>
              </div>
            </Card>

            <Card title="Subscription">
              <dl className="space-y-3 text-sm">
                <Row label="Status" value={subscription?.statusLabel} />
                <Row
                  label="Next billing date"
                  value={formatDate(subscription?.nextBillingDate)}
                />
                <Row
                  label="Payment status"
                  value={
                    summary?.payment?.lastStatus
                      ? summary.payment.lastStatus.replace(/_/g, " ")
                      : "No payments yet"
                  }
                />
                <Row
                  label="Billing contact"
                  value={subscription?.billingEmail ?? "—"}
                />
                <Row
                  label="Billing method"
                  value={
                    subscription?.collectionMethod === "send_invoice"
                      ? "Invoice"
                      : subscription?.collectionMethod
                        ? "Card on file"
                        : "—"
                  }
                />
                {subscription?.cancelAtPeriodEnd && (
                  <Row
                    label="Scheduled to end"
                    value={formatDate(subscription?.nextBillingDate)}
                  />
                )}
              </dl>
            </Card>
          </div>

          <Card
            title="Invoices"
            actions={
              summary?.payment?.latestInvoiceUrl ? (
                <a
                  href={summary.payment.latestInvoiceUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-sm text-theme-text-secondary underline hover:text-theme-text-primary"
                >
                  Latest invoice
                </a>
              ) : null
            }
          >
            <Table
              empty="No invoices yet."
              columns={[
                {
                  key: "number",
                  label: "Invoice",
                  render: (r) => r.number ?? r.id,
                },
                {
                  key: "created",
                  label: "Date",
                  render: (r) => formatDate(r.created),
                },
                {
                  key: "amountDue",
                  label: "Amount",
                  render: (r) =>
                    formatMoney(r.amountPaid || r.amountDue, r.currency),
                },
                {
                  key: "status",
                  label: "Status",
                  render: (r) => (
                    <Badge tone={r.status === "paid" ? "success" : "warning"}>
                      {r.status}
                    </Badge>
                  ),
                },
                {
                  key: "link",
                  label: "",
                  render: (r) =>
                    r.hostedInvoiceUrl ? (
                      <a
                        href={r.hostedInvoiceUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="text-sm underline text-theme-text-secondary hover:text-theme-text-primary"
                      >
                        View
                      </a>
                    ) : (
                      "—"
                    ),
                },
              ]}
              rows={invoices}
            />
          </Card>

          <Card title="Subscription actions">
            <div className="flex flex-wrap items-center gap-3">
              {subscription?.cancelAtPeriodEnd ? (
                <Button
                  variant="secondary"
                  disabled={busy !== null}
                  onClick={() =>
                    act(
                      "resume",
                      () => Business.billing.resume(),
                      "Cancellation reversed. Your subscription will renew."
                    )
                  }
                >
                  Keep my subscription
                </Button>
              ) : (
                <Button
                  variant="danger"
                  disabled={busy !== null || !subscription?.subscriptionId}
                  onClick={() => {
                    if (
                      !window.confirm(
                        "Cancel at the end of the current billing period? Service continues until then and your data is never deleted."
                      )
                    )
                      return;
                    act(
                      "cancel",
                      () => Business.billing.cancel(false),
                      "Cancellation scheduled for the end of the billing period."
                    );
                  }}
                >
                  Cancel subscription
                </Button>
              )}
              <p className="text-xs text-theme-text-secondary">
                Cancelling keeps your service until the end of the period you
                have already paid for. Your data is never deleted.
              </p>
            </div>
          </Card>

          <p className="text-xs text-theme-text-secondary">
            Payments are processed by Stripe. Card details are entered on
            Stripe&apos;s hosted pages and are never stored by this platform.
          </p>
        </BusinessPage>
      </div>
    </div>
  );
}

function Row({ label, value }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <dt className="text-theme-text-secondary">{label}</dt>
      <dd className="text-right font-medium text-theme-text-primary">
        {value ?? "—"}
      </dd>
    </div>
  );
}

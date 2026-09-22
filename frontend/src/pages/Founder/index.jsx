import React, { useCallback, useEffect, useState } from "react";
import Founder from "@/models/founder";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorBanner,
  Table,
} from "@/components/Business/Layout";
import showToast from "@/utils/toast";

/**
 * The founder control plane.
 *
 * One password, then the businesses. The flow it exists to serve, end to end:
 * provision a qualified business, copy the Stripe-hosted Payment Link that is
 * bound to it, and watch for the webhook to activate it. Everything else is
 * reading.
 *
 * Two things this screen deliberately cannot do. It cannot mark a business
 * paid - that is the webhook's job, from an event it can prove belongs to that
 * deployment - and it cannot start a container, because that is a privileged
 * host operation. Where a privileged step is needed the console prints the
 * exact command instead of pretending to run it.
 *
 * Nothing on this page is a control. Hiding a button is not access control:
 * every route behind it refuses a request that is not signed in, and refuses
 * outright on a deployment that is not a control plane.
 */

// ------------------------------------------------------------------ shell --

function Shell({ title, description = null, actions = null, children }) {
  return (
    <div className="min-h-screen w-full overflow-y-auto bg-theme-bg-primary">
      <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-y-6 px-4 py-10 md:px-8">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex flex-col gap-y-1">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-theme-text-secondary">
              Control plane
            </p>
            <h1 className="text-2xl font-semibold text-theme-text-primary">
              {title}
            </h1>
            {description && (
              <p className="max-w-2xl text-sm text-theme-text-secondary">
                {description}
              </p>
            )}
          </div>
          {actions && (
            <div className="flex items-center gap-x-2">{actions}</div>
          )}
        </header>
        {children}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ login --

function SignIn({ onSignedIn }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function submit(event) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);

    const result = await Founder.signIn(password);
    // Cleared either way: it should not sit in a field, in React state, or in
    // anything the browser might restore.
    setPassword("");
    setBusy(false);

    if (!result.success) return setError(result.error);
    onSignedIn();
  }

  return (
    <div className="flex min-h-screen w-full items-center justify-center bg-theme-bg-primary px-4">
      <form
        onSubmit={submit}
        className="w-full max-w-sm rounded-xl border border-theme-modal-border bg-theme-bg-secondary p-6"
      >
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-theme-text-secondary">
          Control plane
        </p>
        <h1 className="mt-1 text-xl font-semibold text-theme-text-primary">
          Sign in
        </h1>

        {error && (
          <div className="mt-4">
            <ErrorBanner message={error} />
          </div>
        )}

        <label
          htmlFor="founder-password"
          className="mt-5 block text-sm text-theme-text-secondary"
        >
          Password
        </label>
        <input
          id="founder-password"
          name="founder-password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoFocus
          className="mt-1 w-full rounded-lg border border-theme-modal-border bg-theme-bg-primary px-3 py-2 text-sm text-theme-text-primary outline-none focus:border-theme-button-primary"
        />

        <Button type="submit" disabled={busy} className="mt-5 w-full">
          {busy ? "Checking…" : "Sign in"}
        </Button>
      </form>
    </div>
  );
}

// ------------------------------------------------------------- provision ---

const BLANK = { slug: "", name: "", domain: "", port: "", paymentLink: "" };

function Provision({ onProvisioned }) {
  const [form, setForm] = useState(BLANK);
  const [problems, setProblems] = useState([]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  const set = (key) => (event) =>
    setForm((current) => ({ ...current, [key]: event.target.value }));

  async function submit(event) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setProblems([]);
    setResult(null);

    const response = await Founder.provision({
      ...form,
      port: Number(form.port),
      // Optional: the link is often created in Stripe afterwards.
      paymentLink: form.paymentLink.trim() || undefined,
    });
    setBusy(false);

    if (!response.success) return setProblems(response.problems ?? []);
    setForm(BLANK);
    setResult(response);
    showToast(`Provisioned ${response.deployment.slug}.`, "success");
    onProvisioned();
  }

  return (
    <Card title="Provision a business">
      <form onSubmit={submit} className="flex flex-col gap-y-4">
        {problems.length > 0 && (
          <div
            role="alert"
            className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-300"
          >
            <p className="font-medium">Nothing was written.</p>
            <ul className="mt-1 list-disc pl-5">
              {problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          </div>
        )}

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field
            label="Identifier"
            hint="Lowercase letters, digits and hyphens. Becomes the directory and container name."
            value={form.slug}
            onChange={set("slug")}
            placeholder="acme"
          />
          <Field
            label="Business name"
            hint="Shown to the customer throughout their own deployment."
            value={form.name}
            onChange={set("name")}
            placeholder="Acme Corporation"
          />
          <Field
            label="Domain"
            hint="The hostname their reverse proxy will serve."
            value={form.domain}
            onChange={set("domain")}
            placeholder="ai.acme.com"
          />
          <Field
            label="Host port"
            hint="Bound on loopback only. Must not collide with another business."
            value={form.port}
            onChange={set("port")}
            placeholder="3101"
            type="number"
          />
        </div>

        <Field
          label="Stripe Payment Link (optional)"
          hint="The hosted link from your Stripe dashboard. It can be added later. Must be an https stripe.com URL."
          value={form.paymentLink}
          onChange={set("paymentLink")}
          placeholder="https://buy.stripe.com/…"
        />

        <p className="text-xs text-theme-text-secondary">
          The business starts unpaid: AI usage is suspended until the Stripe
          webhook records its first payment. Nothing else is restricted and no
          data is affected.
        </p>

        <div>
          <Button type="submit" disabled={busy}>
            {busy ? "Provisioning…" : "Provision"}
          </Button>
        </div>

        {result && (
          <NextCommand
            title={`Configuration written for ${result.deployment.slug}.`}
            command={result.nextCommand}
            note="Run this on the host to build and start the container. The console does not run commands."
          />
        )}
      </form>
    </Card>
  );
}

function Field({
  label,
  hint = null,
  value,
  onChange,
  placeholder = "",
  type = "text",
}) {
  return (
    <div className="flex flex-col">
      <label className="text-sm text-theme-text-primary">{label}</label>
      <input
        type={type}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        className="mt-1 w-full rounded-lg border border-theme-modal-border bg-theme-bg-primary px-3 py-2 text-sm text-theme-text-primary outline-none focus:border-theme-button-primary"
      />
      {hint && <p className="mt-1 text-xs text-theme-text-secondary">{hint}</p>}
    </div>
  );
}

/** A command the operator runs on the host. Shown, never executed. */
function NextCommand({ title, command, note = null }) {
  return (
    <div className="rounded-lg border border-theme-modal-border bg-theme-bg-primary p-4">
      <p className="text-sm text-theme-text-primary">{title}</p>
      <div className="mt-2 flex items-center gap-x-2">
        <code className="flex-1 overflow-x-auto rounded bg-black/30 px-3 py-2 text-xs text-theme-text-primary">
          {command}
        </code>
        <Button variant="secondary" onClick={() => copy(command, "Command")}>
          Copy
        </Button>
      </div>
      {note && <p className="mt-2 text-xs text-theme-text-secondary">{note}</p>}
    </div>
  );
}

async function copy(value, label = "Copied") {
  try {
    await navigator.clipboard.writeText(value);
    showToast(`${label} copied.`, "success");
  } catch {
    showToast("Could not copy. Select the text and copy it manually.", "error");
  }
}

// ------------------------------------------------------------- deployment --

function statusTone(live) {
  if (!live?.status) return "neutral";
  const access = live.status.billing?.access;
  if (access === "restricted") return "danger";
  if (access === "warning") return "warning";
  return "success";
}

function statusLabel(live) {
  if (!live) return "Unknown";
  if (!live.status)
    return live.reachable ? "Responding, no status" : "Not responding";
  const billing = live.status.billing;
  if (billing.reason === "awaiting_activation") return "Awaiting first payment";
  return billing.statusLabel ?? billing.status ?? "Unknown";
}

function Detail({ slug, onClose }) {
  const [detail, setDetail] = useState(null);
  const [link, setLink] = useState(null);
  const [linkInput, setLinkInput] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const [next, paymentLink] = await Promise.all([
      Founder.deployment(slug),
      Founder.paymentLink(slug),
    ]);
    setDetail(next);
    setLink(paymentLink);
    setLoading(false);
  }, [slug]);

  useEffect(() => {
    load();
  }, [load]);

  async function savePaymentLink(event) {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    const result = await Founder.savePaymentLink(slug, linkInput.trim());
    setSaving(false);
    if (!result.success) return showToast(result.error, "error");
    setLinkInput("");
    showToast("Payment link recorded.", "success");
    load();
  }

  if (loading)
    return (
      <Card title={slug}>
        <p className="py-6 text-sm text-theme-text-secondary">Loading…</p>
      </Card>
    );

  if (!detail || detail.error)
    return (
      <Card title={slug}>
        <ErrorBanner message={detail?.error ?? "Could not load."} />
      </Card>
    );

  const { deployment, live } = detail;
  const events = live?.status?.events;

  return (
    <div className="flex flex-col gap-y-6">
      <Card
        title={deployment.name || deployment.slug}
        actions={
          <div className="flex items-center gap-x-2">
            <Button variant="secondary" onClick={load}>
              Refresh
            </Button>
            <Button variant="secondary" onClick={onClose}>
              Back
            </Button>
          </div>
        }
      >
        <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Fact label="Identifier" value={deployment.slug} />
          <Fact label="Domain" value={deployment.domain ?? "—"} />
          <Fact label="Host port" value={deployment.port ?? "—"} />
          <Fact
            label="Application"
            value={<Badge tone={statusTone(live)}>{statusLabel(live)}</Badge>}
          />
          <Fact
            label="AI provider key"
            value={
              <Badge
                tone={deployment.providerConfigured ? "success" : "warning"}
              >
                {deployment.providerConfigured ? "Configured" : "Not set"}
              </Badge>
            }
          />
          <Fact
            label="Payment link"
            value={
              <Badge
                tone={deployment.paymentLinkConfigured ? "success" : "warning"}
              >
                {deployment.paymentLinkConfigured ? "Configured" : "Not set"}
              </Badge>
            }
          />
        </dl>

        {live?.reason && (
          <p className="mt-4 text-sm text-theme-text-secondary">
            {live.reason}
          </p>
        )}

        {live?.status?.billing && (
          <BillingFacts billing={live.status.billing} />
        )}
      </Card>

      <Card title="Stripe-hosted payment link">
        {link?.success ? (
          <div className="flex flex-col gap-y-3">
            <p className="text-sm text-theme-text-secondary">
              This link carries this business&rsquo;s own{" "}
              <code className="text-xs">client_reference_id</code>, which is how
              its webhook matches the payment back. Sending a link without it is
              how a payment ends up unmatched.
            </p>
            <div className="flex items-center gap-x-2">
              <code className="flex-1 overflow-x-auto rounded bg-black/30 px-3 py-2 text-xs text-theme-text-primary">
                {link.url}
              </code>
              <Button onClick={() => copy(link.url, "Payment link")}>
                Copy
              </Button>
            </div>
            {link.plan?.displayPrice && (
              <p className="text-xs text-theme-text-secondary">
                {link.plan.displayPrice}
              </p>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-y-3">
            <p className="text-sm text-theme-text-secondary">
              {link?.error ?? "No payment link is configured."}
            </p>
            <form onSubmit={savePaymentLink} className="flex flex-col gap-y-2">
              <Field
                label="Record the hosted link from Stripe"
                hint="Must be an https stripe.com URL. The console appends the matching identifier itself."
                value={linkInput}
                onChange={(event) => setLinkInput(event.target.value)}
                placeholder="https://buy.stripe.com/…"
              />
              <div>
                <Button type="submit" disabled={saving || !linkInput.trim()}>
                  {saving ? "Saving…" : "Save link"}
                </Button>
              </div>
            </form>
          </div>
        )}
      </Card>

      <Card title="Payment events needing a human">
        {!events ? (
          <p className="text-sm text-theme-text-secondary">
            {live?.reason ??
              "This business is not reporting its status right now."}
          </p>
        ) : events.recent.length === 0 ? (
          <EmptyState
            title="Nothing unmatched"
            description="Every payment event this business received was matched to it or correctly refused."
          />
        ) : (
          <>
            <Table
              columns={[
                { key: "status", label: "Outcome" },
                { key: "type", label: "Event" },
                { key: "summary", label: "Detail" },
                {
                  key: "occurredAt",
                  label: "When",
                  render: (row) =>
                    row.occurredAt
                      ? new Date(row.occurredAt).toLocaleString()
                      : "—",
                },
              ]}
              rows={events.recent.map((event, index) => ({
                ...event,
                id: event.stripeEventId ?? index,
              }))}
            />
            <p className="mt-4 text-xs text-theme-text-secondary">
              These are inspected here and resolved in Stripe. Nothing in this
              console can bind a payment to a business or activate one — that
              would be exactly the mistake an unmatched event is warning about.
            </p>
          </>
        )}
      </Card>

      <NextCommand
        title="Apply configuration changes"
        command={`./scripts/operator.sh update ${deployment.slug}`}
        note="A running container reads its configuration at boot, so a new payment link or provider key needs a restart."
      />
    </div>
  );
}

function Fact({ label, value }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-theme-text-secondary">
        {label}
      </dt>
      <dd className="mt-1 text-sm text-theme-text-primary">{value}</dd>
    </div>
  );
}

function BillingFacts({ billing }) {
  return (
    <dl className="mt-6 grid grid-cols-1 gap-4 border-t border-theme-modal-border pt-6 sm:grid-cols-2 lg:grid-cols-3">
      <Fact
        label="Subscription"
        value={billing.statusLabel ?? billing.status}
      />
      <Fact
        label="Next billing date"
        value={
          billing.nextBillingDate
            ? new Date(billing.nextBillingDate).toLocaleDateString()
            : "—"
        }
      />
      <Fact label="Stripe customer" value={billing.customerId ?? "—"} />
      <Fact label="Stripe subscription" value={billing.subscriptionId ?? "—"} />
      <Fact
        label="Enforcement"
        value={billing.enforcementEnabled ? "On" : "Off"}
      />
      <Fact
        label="Cancels at period end"
        value={billing.cancelAtPeriodEnd ? "Yes" : "No"}
      />
    </dl>
  );
}

// ------------------------------------------------------------------ list ---

function Console({ onSignOut }) {
  const [deployments, setDeployments] = useState([]);
  const [selected, setSelected] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    const result = await Founder.deployments();
    setDeployments(result.deployments ?? []);
    setError(result.error ?? null);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (selected)
    return (
      <Shell title="Business">
        <Detail slug={selected} onClose={() => setSelected(null)} />
      </Shell>
    );

  return (
    <Shell
      title="Managed businesses"
      description="Every business running on this host, and whether it has paid."
      actions={
        <>
          <Button variant="secondary" onClick={load}>
            Refresh
          </Button>
          <Button variant="secondary" onClick={onSignOut}>
            Sign out
          </Button>
        </>
      }
    >
      {error && <ErrorBanner message={error} />}

      <Card title={`Businesses (${deployments.length})`}>
        {loading ? (
          <p className="py-6 text-sm text-theme-text-secondary">Loading…</p>
        ) : deployments.length === 0 ? (
          <EmptyState
            title="No businesses yet"
            description="Provision one below. Nothing is charged and nothing is started until you run the command it gives you."
          />
        ) : (
          <Table
            columns={[
              { key: "slug", label: "Identifier" },
              { key: "name", label: "Business" },
              { key: "domain", label: "Domain" },
              {
                key: "paymentLinkConfigured",
                label: "Payment link",
                render: (row) => (
                  <Badge
                    tone={row.paymentLinkConfigured ? "success" : "warning"}
                  >
                    {row.paymentLinkConfigured ? "Configured" : "Not set"}
                  </Badge>
                ),
              },
              {
                key: "awaitingActivation",
                label: "Billing",
                render: (row) => (
                  <Badge tone={row.awaitingActivation ? "warning" : "neutral"}>
                    {row.awaitingActivation ? "Starts unpaid" : "Managed"}
                  </Badge>
                ),
              },
              {
                key: "open",
                label: "",
                render: (row) => (
                  <Button
                    variant="secondary"
                    onClick={() => setSelected(row.slug)}
                  >
                    Open
                  </Button>
                ),
              },
            ]}
            rows={deployments.map((row) => ({ ...row, id: row.slug }))}
          />
        )}
      </Card>

      <Provision onProvisioned={load} />
    </Shell>
  );
}

// ------------------------------------------------------------------ page ---

export default function FounderConsole() {
  const [state, setState] = useState({ loading: true });

  const refresh = useCallback(async () => {
    const session = await Founder.session();
    setState({ loading: false, ...session });
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  if (state.loading)
    return (
      <div className="flex min-h-screen items-center justify-center bg-theme-bg-primary">
        <p className="text-sm text-theme-text-secondary">Loading…</p>
      </div>
    );

  // Not a control plane. Says so plainly rather than showing a login box that
  // could never succeed - and the API answers 404 regardless of this screen.
  if (!state.available)
    return (
      <Shell title="Not available here">
        <Card>
          <p className="text-sm text-theme-text-secondary">
            {state.reason ??
              "The founder console is not enabled on this deployment."}
          </p>
        </Card>
      </Shell>
    );

  if (!state.authenticated) return <SignIn onSignedIn={refresh} />;

  return (
    <Console
      onSignOut={async () => {
        await Founder.signOut();
        refresh();
      }}
    />
  );
}

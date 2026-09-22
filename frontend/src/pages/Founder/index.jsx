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
 * One password, then the customers. This is the only way an account is created
 * in this product: there is no public signup, no free trial, no self-service
 * organization. If the founder did not create it, it does not exist.
 *
 * The workflow it serves: the founder qualifies a business, sends the Stripe
 * Payment Link by email, confirms the money arrived, then creates the account
 * here with the email and password the customer chose. The customer signs in
 * to this same application.
 *
 * Stripe appears nowhere in this screen's logic. Access is ACTIVE or DISABLED
 * and the founder is the only one who changes it.
 *
 * Nothing here is a control. Hiding a button is not access control: every
 * route behind this page refuses a request without a founder session, and the
 * product refuses a disabled customer on every single request.
 */

// ------------------------------------------------------------------ shell --

function Shell({ title, description = null, actions = null, children }) {
  return (
    <div className="min-h-screen w-full overflow-y-auto bg-theme-bg-primary">
      <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-y-6 px-4 py-10 md:px-8">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex flex-col gap-y-1">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-theme-text-secondary">
              Founder
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

function Field({
  label,
  hint = null,
  value,
  onChange,
  placeholder = "",
  type = "text",
  autoComplete = "off",
}) {
  return (
    <div className="flex flex-col">
      <label className="text-sm text-theme-text-primary">{label}</label>
      <input
        type={type}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        autoComplete={autoComplete}
        className="mt-1 w-full rounded-lg border border-theme-modal-border bg-theme-bg-primary px-3 py-2 text-sm text-theme-text-primary outline-none focus:border-theme-button-primary"
      />
      {hint && <p className="mt-1 text-xs text-theme-text-secondary">{hint}</p>}
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
          Founder
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

// ------------------------------------------------------------ new customer --

const BLANK = {
  businessName: "",
  contactName: "",
  email: "",
  password: "",
  paymentNote: "",
  notes: "",
};

function CreateCustomer({ onCreated }) {
  const [form, setForm] = useState(BLANK);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const set = (key) => (event) =>
    setForm((current) => ({ ...current, [key]: event.target.value }));

  async function submit(event) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);

    const result = await Founder.createCustomer(form);
    setBusy(false);
    if (!result.success) return setError(result.error);

    // The password leaves this component the moment it is accepted.
    setForm(BLANK);
    showToast(`${result.customer.businessName} can now sign in.`, "success");
    onCreated();
  }

  return (
    <Card title="Create a customer account">
      <form onSubmit={submit} className="flex flex-col gap-y-4">
        {error && <ErrorBanner message={error} />}

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field
            label="Business name"
            value={form.businessName}
            onChange={set("businessName")}
            placeholder="Acme Corporation"
          />
          <Field
            label="Contact name (optional)"
            value={form.contactName}
            onChange={set("contactName")}
            placeholder="Dana Reyes"
          />
          <Field
            label="Authorized login email"
            hint="The address they gave you. This is what they sign in with."
            type="email"
            value={form.email}
            onChange={set("email")}
            placeholder="dana@acme.com"
          />
          <Field
            label="Initial password"
            hint="The password they chose. Stored only as a hash — you will not be able to read it back."
            type="password"
            autoComplete="new-password"
            value={form.password}
            onChange={set("password")}
          />
        </div>

        <Field
          label="Payment note (optional)"
          hint="Your own record that they paid, for example the date or invoice. Nothing in the application reads this."
          value={form.paymentNote}
          onChange={set("paymentNote")}
          placeholder="Subscribed 12 Sep, Stripe link"
        />

        <div>
          <Button type="submit" disabled={busy}>
            {busy ? "Creating…" : "Create account"}
          </Button>
        </div>
      </form>
    </Card>
  );
}

// ---------------------------------------------------------------- customer --

function Detail({ id, onClose, onChanged }) {
  const [customer, setCustomer] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmName, setConfirmName] = useState("");
  const [profile, setProfile] = useState({
    businessName: "",
    contactName: "",
    paymentNote: "",
    notes: "",
  });

  const load = useCallback(async () => {
    setLoading(true);
    const next = await Founder.customer(id);
    setCustomer(next);
    if (next)
      setProfile({
        businessName: next.businessName ?? "",
        contactName: next.contactName ?? "",
        paymentNote: next.paymentNote ?? "",
        notes: next.notes ?? "",
      });
    setLoading(false);
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  async function run(action, successMessage) {
    if (busy) return;
    setBusy(true);
    const result = await action();
    setBusy(false);
    if (!result.success) return showToast(result.error, "error");
    showToast(successMessage, "success");
    await load();
    onChanged();
    return result;
  }

  if (loading)
    return (
      <Card>
        <p className="py-6 text-sm text-theme-text-secondary">Loading…</p>
      </Card>
    );

  if (!customer)
    return (
      <Card>
        <ErrorBanner message="That customer no longer exists." />
        <div className="mt-4">
          <Button variant="secondary" onClick={onClose}>
            Back
          </Button>
        </div>
      </Card>
    );

  const disabled = customer.access === "disabled";

  return (
    <div className="flex flex-col gap-y-6">
      <Card
        title={customer.businessName}
        actions={
          <Button variant="secondary" onClick={onClose}>
            Back
          </Button>
        }
      >
        <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Fact label="Login email" value={customer.loginEmail} />
          <Fact
            label="Access"
            value={
              <Badge tone={disabled ? "danger" : "success"}>
                {disabled ? "Disabled" : "Active"}
              </Badge>
            }
          />
          <Fact label="Contact" value={customer.contactName || "—"} />
          <Fact
            label="Created"
            value={new Date(customer.createdAt).toLocaleDateString()}
          />
          <Fact label="Payment note" value={customer.paymentNote || "—"} />
        </dl>

        <div className="mt-6 flex flex-wrap items-center gap-2 border-t border-theme-modal-border pt-6">
          {disabled ? (
            <Button
              disabled={busy}
              onClick={() =>
                run(
                  () => Founder.setAccess(customer.id, "active"),
                  "Access restored. They can sign in again."
                )
              }
            >
              Restore access
            </Button>
          ) : (
            <Button
              variant="danger"
              disabled={busy}
              onClick={() =>
                run(
                  () => Founder.setAccess(customer.id, "disabled"),
                  "Access disabled. Their current session stops working immediately."
                )
              }
            >
              Disable access
            </Button>
          )}
          <p className="text-xs text-theme-text-secondary">
            Disabling takes effect on their very next request, not when their
            session expires. No data is deleted.
          </p>
        </div>
      </Card>

      <Card title="Business information">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field
            label="Business name"
            value={profile.businessName}
            onChange={(e) =>
              setProfile({ ...profile, businessName: e.target.value })
            }
          />
          <Field
            label="Contact name"
            value={profile.contactName}
            onChange={(e) =>
              setProfile({ ...profile, contactName: e.target.value })
            }
          />
          <Field
            label="Payment note"
            value={profile.paymentNote}
            onChange={(e) =>
              setProfile({ ...profile, paymentNote: e.target.value })
            }
          />
          <Field
            label="Notes"
            value={profile.notes}
            onChange={(e) => setProfile({ ...profile, notes: e.target.value })}
          />
        </div>
        <div className="mt-4">
          <Button
            disabled={busy}
            onClick={() =>
              run(() => Founder.updateCustomer(customer.id, profile), "Saved.")
            }
          >
            Save
          </Button>
        </div>
      </Card>

      <Card title="Credentials">
        <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
          <div>
            <Field
              label="Change login email"
              hint="The old address stops working immediately."
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder={customer.loginEmail}
            />
            <div className="mt-3">
              <Button
                disabled={busy || !email.trim()}
                onClick={async () => {
                  const result = await run(
                    () => Founder.changeEmail(customer.id, email.trim()),
                    "Login email changed."
                  );
                  if (result?.success) setEmail("");
                }}
              >
                Change email
              </Button>
            </div>
          </div>

          <div>
            <Field
              label="Set a new password"
              hint="The current one cannot be shown — only a hash is stored. Setting a new one invalidates the old."
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <div className="mt-3">
              <Button
                disabled={busy || !password}
                onClick={async () => {
                  const result = await run(
                    () => Founder.resetPassword(customer.id, password),
                    "Password set."
                  );
                  if (result?.success) setPassword("");
                }}
              >
                Set password
              </Button>
            </div>
          </div>
        </div>
      </Card>

      <Card title="Remove permanently">
        <p className="text-sm text-theme-text-secondary">
          This deletes the account and its login. It cannot be undone.{" "}
          <strong className="text-theme-text-primary">
            Disabling is the reversible option
          </strong>{" "}
          and keeps everything.
        </p>
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <div className="min-w-[260px] flex-1">
            <Field
              label={`Type "${customer.businessName}" to confirm`}
              value={confirmName}
              onChange={(e) => setConfirmName(e.target.value)}
            />
          </div>
          <Button
            variant="danger"
            disabled={busy || confirmName !== customer.businessName}
            onClick={async () => {
              const result = await Founder.removeCustomer(
                customer.id,
                confirmName
              );
              if (!result.success) return showToast(result.error, "error");
              showToast("Customer removed.", "success");
              onChanged();
              onClose();
            }}
          >
            Remove permanently
          </Button>
        </div>
      </Card>
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

// ------------------------------------------------------------------ list ---

/**
 * What this deployment can and cannot do right now.
 *
 * Founder-only, and it exists so the answer to "is this ready to sell?" is on
 * the screen rather than in a log. It shows nothing at all once both parts are
 * working - a green panel on every visit is just noise.
 */
function Readiness({ status }) {
  if (!status) return null;

  const database = status.database === "postgres";
  const model = status.ok === true;
  if (database && model) return null;

  const rows = [
    {
      ok: database,
      label: "Customer accounts",
      good: "Stored in Postgres.",
      bad: "No database yet, so accounts cannot be created. Add a Postgres DATABASE_URL to this deployment.",
    },
    {
      ok: model,
      label: "AI assistant",
      good: `Answering through ${status.provider}${status.model ? ` (${status.model})` : ""}.`,
      bad: "No model provider yet, so customers cannot chat. Add a provider key to this deployment.",
    },
  ];

  return (
    <div className="mb-6 rounded-lg border border-yellow-600/40 bg-yellow-500/5 p-4">
      <p className="mb-3 text-sm font-medium text-theme-text-primary">
        This deployment is not ready to sell yet
      </p>
      <ul className="space-y-2">
        {rows.map((row) => (
          <li key={row.label} className="flex gap-3 text-sm">
            <span aria-hidden="true">{row.ok ? "✓" : "•"}</span>
            <span>
              <span className="font-medium text-theme-text-primary">
                {row.label}:{" "}
              </span>
              <span className="text-theme-text-secondary">
                {row.ok ? row.good : row.bad}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Console({ onSignOut }) {
  const [customers, setCustomers] = useState([]);
  const [counts, setCounts] = useState({});
  const [selected, setSelected] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [status, setStatus] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    Founder.status().then(setStatus);
    const result = await Founder.customers();
    setCustomers(result.customers ?? []);
    setCounts(result.counts ?? {});
    setError(result.error ?? null);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (selected !== null)
    return (
      <Shell title="Customer">
        <Detail
          id={selected}
          onClose={() => setSelected(null)}
          onChanged={load}
        />
      </Shell>
    );

  return (
    <Shell
      title="Customers"
      description="Everyone authorized to use this application. There is no public signup — an account exists because you created it."
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

      <Readiness status={status} />

      <Card
        title={`Accounts (${counts.active ?? 0} active, ${
          counts.disabled ?? 0
        } disabled)`}
      >
        {loading ? (
          <p className="py-6 text-sm text-theme-text-secondary">Loading…</p>
        ) : customers.length === 0 ? (
          <EmptyState
            title="No customers yet"
            description="Once a business has paid, create their account below and they can sign in."
          />
        ) : (
          <Table
            columns={[
              { key: "businessName", label: "Business" },
              { key: "loginEmail", label: "Login email" },
              { key: "contactName", label: "Contact" },
              {
                key: "access",
                label: "Access",
                render: (row) => (
                  <Badge
                    tone={row.access === "disabled" ? "danger" : "success"}
                  >
                    {row.access === "disabled" ? "Disabled" : "Active"}
                  </Badge>
                ),
              },
              {
                key: "createdAt",
                label: "Created",
                render: (row) => new Date(row.createdAt).toLocaleDateString(),
              },
              {
                key: "open",
                label: "",
                render: (row) => (
                  <Button
                    variant="secondary"
                    onClick={() => setSelected(row.id)}
                  >
                    Manage
                  </Button>
                ),
              },
            ]}
            rows={customers}
          />
        )}
      </Card>

      <CreateCustomer onCreated={load} />
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

  // Not configured as a control plane. Says so plainly rather than showing a
  // login box that could never succeed - and the API answers 404 regardless of
  // what this screen decides to render.
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

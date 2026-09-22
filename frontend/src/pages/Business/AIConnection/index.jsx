import React, { useEffect, useState } from "react";
import Sidebar from "@/components/SettingsSidebar";
import { isMobile } from "react-device-detect";
import Business from "@/models/business";
import BusinessPage, {
  Button,
  Badge,
  Card,
  EmptyState,
} from "@/components/Business/Layout";
import showToast from "@/utils/toast";

/**
 * Where a business connects the AI service they chose.
 *
 * This product does not come with a model. Each business brings the service
 * they already use and their own key, so their usage is theirs — their
 * account, their limits, their bill. Nothing here is shared with any other
 * business using this application.
 *
 * The key is sent once and never comes back. Changing a model does not mean
 * typing the key again.
 */

const FIELD_LABELS = {
  baseUrl: "Base URL",
  apiKey: "API key",
  model: "Model",
  embeddingModel: "Embedding model",
};

const FIELD_HINTS = {
  baseUrl: "The address of the service, ending in /v1 for most of them.",
  apiKey: "Sent once, stored encrypted, and never shown again.",
  model: "The exact model name your service expects.",
  embeddingModel: "Optional. Only needed for searching your own documents.",
};

export default function AIConnectionPage() {
  const [options, setOptions] = useState([]);
  const [connection, setConnection] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [form, setForm] = useState(null);

  async function load() {
    setLoading(true);
    const [optionResult, current] = await Promise.all([
      Business.aiConnection.options(),
      Business.aiConnection.get(),
    ]);
    if (optionResult?.error) setError(optionResult.error);
    else setOptions(optionResult?.options ?? []);
    setConnection(current?.connection ?? null);
    setLoading(false);
  }

  useEffect(() => {
    load();
  }, []);

  const chosen = form ? options.find((o) => o.type === form.provider) : null;

  function startEditing(providerType) {
    const option = options.find((o) => o.type === providerType);
    setForm({
      provider: providerType,
      baseUrl: connection?.provider === providerType ? connection.baseUrl : "",
      model:
        connection?.provider === providerType
          ? connection.model
          : (option?.defaultModel ?? ""),
      embeddingModel:
        connection?.provider === providerType
          ? (connection.embeddingModel ?? "")
          : "",
      apiKey: "",
    });
  }

  async function save() {
    setSaving(true);
    const body = {
      provider: form.provider,
      baseUrl: form.baseUrl || undefined,
      model: form.model || undefined,
      embeddingModel: form.embeddingModel || undefined,
    };
    // Omitting the key keeps the stored one. Only send it when they typed one.
    if (form.apiKey) body.apiKey = form.apiKey;

    const result = await Business.aiConnection.save(body);
    setSaving(false);

    if (result?.error) return showToast(result.error, "error");
    setConnection(result.connection);
    setForm(null);
    showToast("AI connection saved.", "success");
  }

  async function test() {
    setTesting(true);
    const result = await Business.aiConnection.test();
    setTesting(false);
    if (result?.ok)
      return showToast("Connected — your AI service answered.", "success");
    showToast(result?.reason ?? "Could not reach your AI service.", "error");
  }

  async function disconnect() {
    if (
      !window.confirm(
        "Disconnect your AI service? Your account, workspace and past conversations stay exactly as they are — you simply will not be able to chat until you connect a service again."
      )
    )
      return;
    const result = await Business.aiConnection.remove();
    if (result?.error) return showToast(result.error, "error");
    setConnection(null);
    showToast("AI service disconnected.", "success");
  }

  return (
    <div className="w-screen h-screen overflow-hidden bg-theme-bg-container flex">
      <Sidebar />
      <div
        style={{ height: isMobile ? "100%" : "calc(100% - 32px)" }}
        className="relative md:ml-[2px] md:mr-[16px] md:my-[16px] md:rounded-[16px] bg-theme-bg-secondary w-full h-full overflow-y-scroll"
      >
        <BusinessPage
          title="AI connection"
          description="Connect the AI service your business uses. Your key stays yours — your usage is billed to your own account, and no other business on this application can see or use it."
          loading={loading}
          error={error}
        >
          {connection && !form && (
            <Card
              title="Connected"
              action={
                <div className="flex gap-2">
                  <Button variant="secondary" onClick={test} disabled={testing}>
                    {testing ? "Testing…" : "Test"}
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={() => startEditing(connection.provider)}
                  >
                    Edit
                  </Button>
                  <Button variant="secondary" onClick={disconnect}>
                    Disconnect
                  </Button>
                </div>
              }
            >
              <dl className="grid grid-cols-1 gap-3 py-2 md:grid-cols-2">
                <Detail label="Service" value={connection.providerLabel} />
                <Detail label="Model" value={connection.model ?? "—"} />
                {connection.baseUrl && (
                  <Detail label="Base URL" value={connection.baseUrl} />
                )}
                <div>
                  <dt className="text-xs text-theme-text-secondary">API key</dt>
                  <dd className="mt-1">
                    {connection.credential ? (
                      <Badge tone="success">Configured</Badge>
                    ) : (
                      <Badge tone="neutral">Not needed</Badge>
                    )}
                  </dd>
                </div>
              </dl>
            </Card>
          )}

          {!connection && !form && (
            <Card title="Choose your AI service">
              <p className="pb-4 text-sm text-theme-text-secondary">
                Everything else in the product works already. Connect a service
                here to start chatting.
              </p>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
                {options.map((option) => (
                  <div
                    key={option.type}
                    className="flex flex-col justify-between rounded-lg border border-theme-modal-border p-4"
                  >
                    <div>
                      <p className="text-sm font-medium text-theme-text-primary">
                        {option.label}
                      </p>
                      {option.help && (
                        <p className="mt-1 text-xs text-theme-text-secondary">
                          {option.help}
                        </p>
                      )}
                    </div>
                    <Button
                      variant="secondary"
                      className="mt-3 w-full"
                      onClick={() => startEditing(option.type)}
                    >
                      Connect
                    </Button>
                  </div>
                ))}
              </div>
              {options.length === 0 && (
                <EmptyState title="No AI services are available to connect." />
              )}
            </Card>
          )}

          {form && chosen && (
            <Card
              title={`Connect ${chosen.label}`}
              action={
                <Button variant="secondary" onClick={() => setForm(null)}>
                  Cancel
                </Button>
              }
            >
              <div className="space-y-4 py-2">
                {[...chosen.requires, ...chosen.optional].map((field) => (
                  <Field
                    key={field}
                    name={field}
                    required={chosen.requires.includes(field)}
                    value={form[field] ?? ""}
                    placeholder={
                      field === "apiKey" && connection?.credential
                        ? "Leave blank to keep the saved key"
                        : ""
                    }
                    onChange={(value) =>
                      setForm((current) => ({ ...current, [field]: value }))
                    }
                  />
                ))}
                <Button onClick={save} disabled={saving}>
                  {saving ? "Saving…" : "Save connection"}
                </Button>
              </div>
            </Card>
          )}
        </BusinessPage>
      </div>
    </div>
  );
}

function Detail({ label, value }) {
  return (
    <div>
      <dt className="text-xs text-theme-text-secondary">{label}</dt>
      <dd className="mt-1 text-sm text-theme-text-primary break-all">
        {value}
      </dd>
    </div>
  );
}

function Field({ name, value, onChange, required, placeholder }) {
  return (
    <label className="block">
      <span className="text-sm text-theme-text-primary">
        {FIELD_LABELS[name] ?? name}
        {required ? "" : " (optional)"}
      </span>
      <input
        type={name === "apiKey" ? "password" : "text"}
        autoComplete={name === "apiKey" ? "new-password" : "off"}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        className="mt-1 w-full rounded-lg border border-theme-modal-border bg-theme-settings-input-bg px-3 py-2 text-sm text-theme-text-primary placeholder:text-theme-settings-input-placeholder focus:outline-primary-button"
      />
      {FIELD_HINTS[name] && (
        <span className="mt-1 block text-xs text-theme-text-secondary">
          {FIELD_HINTS[name]}
        </span>
      )}
    </label>
  );
}

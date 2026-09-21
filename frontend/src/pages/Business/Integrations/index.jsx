import React, { useEffect, useState } from "react";
import Sidebar from "@/components/SettingsSidebar";
import { isMobile } from "react-device-detect";
import Business from "@/models/business";
import BusinessPage, {
  Button,
  Badge,
  Card,
  Table,
  EmptyState,
} from "@/components/Business/Layout";
import { Modal } from "../Agents";
import showToast from "@/utils/toast";

export default function IntegrationsPage() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [creating, setCreating] = useState(null);

  async function load() {
    setLoading(true);
    const result = await Business.integrations.all();
    if (result?.error) setError(result.error);
    else setData(result);
    setLoading(false);
  }

  useEffect(() => {
    load();
  }, []);

  return (
    <div className="w-screen h-screen overflow-hidden bg-theme-bg-container flex">
      <Sidebar />
      <div
        style={{ height: isMobile ? "100%" : "calc(100% - 32px)" }}
        className="relative md:ml-[2px] md:mr-[16px] md:my-[16px] md:rounded-[16px] bg-theme-bg-secondary w-full h-full overflow-y-scroll"
      >
        <BusinessPage
          title="Integrations"
          description="Send leads, escalations and other AI activity to the systems your team already uses."
          loading={loading}
          error={error}
        >
          <Card title="Available integrations">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
              {(data?.catalogue ?? []).map((provider) => (
                <div
                  key={provider.provider}
                  className="flex flex-col justify-between rounded-lg border border-theme-modal-border p-4"
                >
                  <div>
                    <p className="text-sm font-medium text-theme-text-primary">
                      {provider.label}
                    </p>
                    <p className="mt-1 text-xs text-theme-text-secondary">
                      {provider.description}
                    </p>
                    {provider.provider === "email" && !data?.emailAvailable && (
                      <p className="mt-2 text-xs text-amber-400">
                        Email delivery needs SMTP configured on this deployment.
                      </p>
                    )}
                  </div>
                  <Button
                    variant="secondary"
                    className="mt-3 w-full"
                    onClick={() => setCreating(provider)}
                  >
                    Connect
                  </Button>
                </div>
              ))}
            </div>
          </Card>

          {!data?.integrations?.length ? (
            <EmptyState
              title="Nothing connected yet"
              description="Connect a generic webhook to send every captured lead to your CRM, Zapier, or your own service."
            />
          ) : (
            <Card title="Connected">
              <Table
                columns={[
                  {
                    key: "name",
                    label: "Integration",
                    render: (row) => (
                      <div>
                        <p className="font-medium">{row.name}</p>
                        <p className="text-xs capitalize text-theme-text-secondary">
                          {row.provider}
                        </p>
                      </div>
                    ),
                  },
                  {
                    key: "events",
                    label: "Sends on",
                    render: (row) => (
                      <div className="flex flex-wrap gap-1">
                        {(row.events ?? []).map((event) => (
                          <Badge key={event}>{event}</Badge>
                        ))}
                      </div>
                    ),
                  },
                  {
                    key: "lastStatus",
                    label: "Last delivery",
                    render: (row) =>
                      row.lastStatus ? (
                        <div>
                          <Badge
                            tone={
                              row.lastStatus === "success"
                                ? "success"
                                : "danger"
                            }
                          >
                            {row.lastStatus}
                          </Badge>
                          {row.lastError && (
                            <p className="mt-1 max-w-xs text-xs text-red-400">
                              {row.lastError}
                            </p>
                          )}
                        </div>
                      ) : (
                        "—"
                      ),
                  },
                  {
                    key: "enabled",
                    label: "Status",
                    render: (row) => (
                      <Badge tone={row.enabled ? "success" : "neutral"}>
                        {row.enabled ? "Enabled" : "Disabled"}
                      </Badge>
                    ),
                  },
                  {
                    key: "actions",
                    label: "",
                    render: (row) => (
                      <div className="flex gap-3">
                        <button
                          type="button"
                          onClick={async () => {
                            showToast("Sending test…", "info");
                            const result = await Business.integrations.test(
                              row.uuid
                            );
                            if (!result?.success)
                              return showToast(
                                result?.error ?? "Test delivery failed.",
                                "error"
                              );
                            showToast(
                              "Test delivered successfully.",
                              "success"
                            );
                            load();
                          }}
                          className="text-xs underline text-theme-text-secondary hover:text-theme-text-primary"
                        >
                          Test
                        </button>
                        <button
                          type="button"
                          onClick={async () => {
                            const result = await Business.integrations.update(
                              row.uuid,
                              {
                                enabled: !row.enabled,
                              }
                            );
                            if (result?.error)
                              return showToast(result.error, "error");
                            load();
                          }}
                          className="text-xs underline text-theme-text-secondary hover:text-theme-text-primary"
                        >
                          {row.enabled ? "Disable" : "Enable"}
                        </button>
                        <button
                          type="button"
                          onClick={async () => {
                            if (!window.confirm("Remove this integration?"))
                              return;
                            const result = await Business.integrations.delete(
                              row.uuid
                            );
                            if (result?.error)
                              return showToast(result.error, "error");
                            showToast("Removed.", "success");
                            load();
                          }}
                          className="text-xs underline text-red-400"
                        >
                          Remove
                        </button>
                      </div>
                    ),
                  },
                ]}
                rows={data.integrations}
              />
            </Card>
          )}

          {creating && (
            <ConnectIntegration
              provider={creating}
              events={data?.events ?? []}
              onClose={() => setCreating(null)}
              onCreated={() => {
                setCreating(null);
                load();
              }}
            />
          )}
        </BusinessPage>
      </div>
    </div>
  );
}

function ConnectIntegration({ provider, events, onClose, onCreated }) {
  const [name, setName] = useState(provider.label);
  const [config, setConfig] = useState({});
  const [secrets, setSecrets] = useState({});
  const [selectedEvents, setSelectedEvents] = useState([
    "lead.created",
    "escalation.created",
  ]);
  const [saving, setSaving] = useState(false);

  async function submit() {
    setSaving(true);
    const result = await Business.integrations.create({
      name,
      provider: provider.provider,
      config,
      secrets,
      events: selectedEvents,
    });
    setSaving(false);
    if (result?.error) return showToast(result.error, "error");
    showToast("Integration connected.", "success");
    onCreated();
  }

  return (
    <Modal title={`Connect ${provider.label}`} onClose={onClose}>
      <p className="text-sm text-theme-text-secondary">
        {provider.description}
      </p>

      <label className="mt-4 block text-sm">
        <span className="text-theme-text-secondary">Name</span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="mt-1 w-full rounded-lg border border-theme-modal-border bg-theme-bg-primary px-3 py-2 text-theme-text-primary"
        />
      </label>

      {provider.configFields.map((field) => (
        <label key={field.key} className="mt-4 block text-sm">
          <span className="text-theme-text-secondary">
            {field.label}
            {field.required ? " *" : ""}
          </span>
          <input
            type={field.type === "email" ? "email" : "text"}
            value={config[field.key] ?? ""}
            onChange={(e) =>
              setConfig({ ...config, [field.key]: e.target.value })
            }
            className="mt-1 w-full rounded-lg border border-theme-modal-border bg-theme-bg-primary px-3 py-2 text-theme-text-primary"
          />
          {field.help && (
            <span className="mt-1 block text-xs text-theme-text-secondary">
              {field.help}
            </span>
          )}
        </label>
      ))}

      {provider.secretFields.map((field) => (
        <label key={field.key} className="mt-4 block text-sm">
          <span className="text-theme-text-secondary">
            {field.label}
            {field.required ? " *" : ""}
          </span>
          <input
            type="password"
            autoComplete="new-password"
            value={secrets[field.key] ?? ""}
            onChange={(e) =>
              setSecrets({ ...secrets, [field.key]: e.target.value })
            }
            className="mt-1 w-full rounded-lg border border-theme-modal-border bg-theme-bg-primary px-3 py-2 text-theme-text-primary"
          />
          <span className="mt-1 block text-xs text-theme-text-secondary">
            {field.help ??
              "Stored encrypted on this server and never shown again after saving."}
          </span>
        </label>
      ))}

      <div className="mt-4">
        <p className="text-sm text-theme-text-secondary">
          Send on these events
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          {events.map((event) => (
            <button
              key={event}
              type="button"
              onClick={() =>
                setSelectedEvents(
                  selectedEvents.includes(event)
                    ? selectedEvents.filter((e) => e !== event)
                    : [...selectedEvents, event]
                )
              }
              className={`rounded-full border px-2.5 py-1 text-xs ${
                selectedEvents.includes(event)
                  ? "border-blue-500/50 bg-blue-500/10 text-blue-300"
                  : "border-theme-modal-border text-theme-text-secondary"
              }`}
            >
              {event}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-6 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={submit} disabled={saving}>
          {saving ? "Connecting…" : "Connect"}
        </Button>
      </div>
    </Modal>
  );
}

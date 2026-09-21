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

/** Website agents: the productized embed, secure by default. */
export default function WebsiteAgentsPage() {
  const [data, setData] = useState(null);
  const [agents, setAgents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [creating, setCreating] = useState(false);
  const [snippet, setSnippet] = useState(null);

  async function load() {
    setLoading(true);
    const [result, agentResult] = await Promise.all([
      Business.websiteAgents.all(),
      Business.agents.all(),
    ]);
    if (result?.error) setError(result.error);
    else setData(result);
    setAgents(agentResult?.agents ?? []);
    setLoading(false);
  }

  useEffect(() => {
    load();
  }, []);

  async function showSnippet(uuid) {
    const result = await Business.websiteAgents.snippet(uuid);
    if (result?.error) return showToast(result.error, "error");
    setSnippet(result);
  }

  return (
    <div className="w-screen h-screen overflow-hidden bg-theme-bg-container flex">
      <Sidebar />
      <div
        style={{ height: isMobile ? "100%" : "calc(100% - 32px)" }}
        className="relative md:ml-[2px] md:mr-[16px] md:my-[16px] md:rounded-[16px] bg-theme-bg-secondary w-full h-full overflow-y-scroll"
      >
        <BusinessPage
          title="Website Agent"
          description="Put an AI agent on your website. Every agent is locked to the domains you list."
          loading={loading}
          error={error}
          actions={
            <Button onClick={() => setCreating(true)}>New website agent</Button>
          }
        >
          {!data?.websiteAgents?.length ? (
            <EmptyState
              title="No website agents yet"
              description="Create one to get a copy-and-paste snippet for your site. You will be asked which domains may use it."
              action={
                <Button onClick={() => setCreating(true)}>
                  Create website agent
                </Button>
              }
            />
          ) : (
            <Card>
              <Table
                columns={[
                  {
                    key: "agent",
                    label: "Agent",
                    render: (row) =>
                      row.agent?.name ?? row.workspaceName ?? "—",
                  },
                  {
                    key: "allowlist",
                    label: "Allowed domains",
                    render: (row) =>
                      row.allowlistConfigured ? (
                        <span className="text-xs">
                          {row.allowlistDomains.join(", ")}
                        </span>
                      ) : (
                        <Badge tone="danger">
                          Any website — not restricted
                        </Badge>
                      ),
                  },
                  {
                    key: "limits",
                    label: "Rate limits",
                    render: (row) => (
                      <span className="text-xs">
                        {row.maxChatsPerDay ?? "∞"}/day ·{" "}
                        {row.maxChatsPerSession ?? "∞"}
                        /visitor
                      </span>
                    ),
                  },
                  { key: "chatCount", label: "Chats" },
                  {
                    key: "enabled",
                    label: "Status",
                    render: (row) => (
                      <Badge tone={row.enabled ? "success" : "neutral"}>
                        {row.enabled ? "Live" : "Disabled"}
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
                          onClick={() => showSnippet(row.uuid)}
                          className="text-xs underline text-theme-text-secondary hover:text-theme-text-primary"
                        >
                          Embed code
                        </button>
                        <button
                          type="button"
                          onClick={async () => {
                            const result = await Business.websiteAgents.update(
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
                      </div>
                    ),
                  },
                ]}
                rows={data.websiteAgents}
              />
            </Card>
          )}

          {creating && (
            <CreateWebsiteAgent
              agents={agents}
              requireAllowlist={data?.requireAllowlist}
              onClose={() => setCreating(false)}
              onCreated={() => {
                setCreating(false);
                load();
              }}
            />
          )}

          {snippet && (
            <Modal
              title="Website embed code"
              onClose={() => setSnippet(null)}
              wide
            >
              <p className="text-sm text-theme-text-secondary">
                Paste this immediately before the closing &lt;/body&gt; tag on
                every page where the agent should appear.
              </p>
              <pre className="mt-3 overflow-x-auto rounded-lg border border-theme-modal-border bg-theme-bg-primary p-3 text-xs text-theme-text-primary">
                {snippet.snippet}
              </pre>
              <div className="mt-4 flex justify-end gap-2">
                <Button
                  onClick={() => {
                    navigator.clipboard?.writeText(snippet.snippet);
                    showToast("Embed code copied.", "success");
                  }}
                >
                  Copy code
                </Button>
              </div>
            </Modal>
          )}
        </BusinessPage>
      </div>
    </div>
  );
}

function CreateWebsiteAgent({ agents, requireAllowlist, onClose, onCreated }) {
  const [form, setForm] = useState({
    agentUuid: "",
    domains: "",
    maxChatsPerDay: 200,
    maxChatsPerSession: 30,
    chatMode: "query",
  });
  const [saving, setSaving] = useState(false);

  async function submit() {
    const domains = form.domains
      .split(/[\n,]/)
      .map((d) => d.trim())
      .filter(Boolean);

    if (!form.agentUuid)
      return showToast("Choose which agent to publish.", "error");
    if (requireAllowlist && !domains.length)
      return showToast("Add at least one allowed website domain.", "error");

    setSaving(true);
    const result = await Business.websiteAgents.create({
      agentUuid: form.agentUuid,
      allowlistDomains: domains,
      maxChatsPerDay: Number(form.maxChatsPerDay),
      maxChatsPerSession: Number(form.maxChatsPerSession),
      chatMode: form.chatMode,
    });
    setSaving(false);
    if (result?.error) return showToast(result.error, "error");
    showToast("Website agent created.", "success");
    onCreated();
  }

  return (
    <Modal title="New website agent" onClose={onClose}>
      <label className="block text-sm">
        <span className="text-theme-text-secondary">Which agent?</span>
        <select
          value={form.agentUuid}
          onChange={(e) => setForm({ ...form, agentUuid: e.target.value })}
          className="mt-1 w-full rounded-lg border border-theme-modal-border bg-theme-bg-primary px-3 py-2 text-theme-text-primary"
        >
          <option value="">Select an agent…</option>
          {agents.map((agent) => (
            <option key={agent.uuid} value={agent.uuid}>
              {agent.name}
            </option>
          ))}
        </select>
      </label>

      <label className="mt-4 block text-sm">
        <span className="text-theme-text-secondary">
          Allowed website domains (one per line)
        </span>
        <textarea
          rows={4}
          value={form.domains}
          onChange={(e) => setForm({ ...form, domains: e.target.value })}
          placeholder={"https://www.example.com\nhttps://example.com"}
          className="mt-1 w-full rounded-lg border border-theme-modal-border bg-theme-bg-primary px-3 py-2 font-mono text-xs text-theme-text-primary"
        />
        <span className="mt-1 block text-xs text-theme-text-secondary">
          Include the scheme (https://). Requests from any other site are
          refused, so your agent cannot be used on someone else&apos;s website.
        </span>
      </label>

      <div className="mt-4 grid grid-cols-2 gap-4">
        <label className="block text-sm">
          <span className="text-theme-text-secondary">Max chats per day</span>
          <input
            type="number"
            min="1"
            value={form.maxChatsPerDay}
            onChange={(e) =>
              setForm({ ...form, maxChatsPerDay: e.target.value })
            }
            className="mt-1 w-full rounded-lg border border-theme-modal-border bg-theme-bg-primary px-3 py-2 text-theme-text-primary"
          />
        </label>
        <label className="block text-sm">
          <span className="text-theme-text-secondary">
            Max chats per visitor
          </span>
          <input
            type="number"
            min="1"
            value={form.maxChatsPerSession}
            onChange={(e) =>
              setForm({ ...form, maxChatsPerSession: e.target.value })
            }
            className="mt-1 w-full rounded-lg border border-theme-modal-border bg-theme-bg-primary px-3 py-2 text-theme-text-primary"
          />
        </label>
      </div>

      <div className="mt-6 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={submit} disabled={saving}>
          {saving ? "Creating…" : "Create"}
        </Button>
      </div>
    </Modal>
  );
}

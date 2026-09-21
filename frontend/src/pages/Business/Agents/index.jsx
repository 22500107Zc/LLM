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
import showToast from "@/utils/toast";

/** AI agent management - a business view over the underlying workspaces. */
export default function AgentsPage() {
  const [data, setData] = useState(null);
  const [templates, setTemplates] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState(null);

  async function load() {
    setLoading(true);
    const [agentResult, templateResult] = await Promise.all([
      Business.agents.all(),
      Business.agents.templates(),
    ]);
    if (agentResult?.error) setError(agentResult.error);
    else setData(agentResult);
    if (!templateResult?.error) setTemplates(templateResult);
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
          title="AI Agents"
          description="Each agent has its own instructions, knowledge and audience."
          loading={loading}
          error={error}
          actions={<Button onClick={() => setCreating(true)}>New agent</Button>}
        >
          {data?.limits && (
            <p className="text-xs text-theme-text-secondary">
              Public website agents: {data.limits.publicAgentsUsed} of{" "}
              {data.limits.maxPublicAgents} included.
            </p>
          )}

          {!data?.agents?.length ? (
            <EmptyState
              title="No agents yet"
              description="Start from a template such as Customer Support or Internal Knowledge, then point it at your company documents."
              action={
                <Button onClick={() => setCreating(true)}>
                  Create your first agent
                </Button>
              }
            />
          ) : (
            <Card>
              <Table
                columns={[
                  {
                    key: "name",
                    label: "Agent",
                    render: (agent) => (
                      <div>
                        <p className="font-medium">{agent.name}</p>
                        <p className="text-xs text-theme-text-secondary line-clamp-1">
                          {agent.description ?? "—"}
                        </p>
                      </div>
                    ),
                  },
                  {
                    key: "visibility",
                    label: "Audience",
                    render: (agent) => (
                      <Badge
                        tone={
                          agent.visibility === "public" ? "info" : "neutral"
                        }
                      >
                        {agent.visibility === "public" ? "Website" : "Internal"}
                      </Badge>
                    ),
                  },
                  {
                    key: "model",
                    label: "Model",
                    render: (agent) =>
                      agent.workspace?.model ?? "Deployment default",
                  },
                  {
                    key: "knowledge",
                    label: "Documents",
                    render: (agent) => agent.knowledge?.documentCount ?? 0,
                  },
                  {
                    key: "features",
                    label: "Capture",
                    render: (agent) => (
                      <div className="flex gap-1">
                        {agent.leadCapture && (
                          <Badge tone="success">Leads</Badge>
                        )}
                        {agent.escalation && (
                          <Badge tone="warning">Escalation</Badge>
                        )}
                        {!agent.leadCapture && !agent.escalation && "—"}
                      </div>
                    ),
                  },
                  {
                    key: "active",
                    label: "Status",
                    render: (agent) => (
                      <Badge tone={agent.active ? "success" : "neutral"}>
                        {agent.active ? "Active" : "Inactive"}
                      </Badge>
                    ),
                  },
                  {
                    key: "actions",
                    label: "",
                    render: (agent) => (
                      <button
                        type="button"
                        onClick={() => setEditing(agent)}
                        className="text-xs underline text-theme-text-secondary hover:text-theme-text-primary"
                      >
                        Configure
                      </button>
                    ),
                  },
                ]}
                rows={data.agents}
              />
            </Card>
          )}

          {creating && (
            <AgentCreate
              templates={templates}
              onClose={() => setCreating(false)}
              onCreated={() => {
                setCreating(false);
                load();
              }}
            />
          )}

          {editing && (
            <AgentEdit
              agent={editing}
              leadFields={templates?.leadCaptureFields ?? []}
              onClose={() => setEditing(null)}
              onSaved={() => {
                setEditing(null);
                load();
              }}
            />
          )}
        </BusinessPage>
      </div>
    </div>
  );
}

function AgentCreate({ templates, onClose, onCreated }) {
  const [form, setForm] = useState({ name: "", description: "", template: "" });
  const [saving, setSaving] = useState(false);

  async function submit() {
    if (!form.name.trim()) return showToast("Give the agent a name.", "error");
    setSaving(true);
    const result = await Business.agents.create(form);
    setSaving(false);
    if (result?.error) return showToast(result.error, "error");
    showToast("Agent created.", "success");
    onCreated();
  }

  return (
    <Modal title="New AI agent" onClose={onClose}>
      <label className="block text-sm">
        <span className="text-theme-text-secondary">Name</span>
        <input
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          placeholder="Customer Support"
          className="mt-1 w-full rounded-lg border border-theme-modal-border bg-theme-bg-primary px-3 py-2 text-theme-text-primary"
        />
      </label>

      <label className="mt-4 block text-sm">
        <span className="text-theme-text-secondary">Description</span>
        <input
          value={form.description}
          onChange={(e) => setForm({ ...form, description: e.target.value })}
          placeholder="Answers customer questions about our products"
          className="mt-1 w-full rounded-lg border border-theme-modal-border bg-theme-bg-primary px-3 py-2 text-theme-text-primary"
        />
      </label>

      <div className="mt-4">
        <p className="text-sm text-theme-text-secondary">
          Start from a template
        </p>
        <div className="mt-2 grid grid-cols-1 gap-2">
          {(templates?.templates ?? []).map((template) => (
            <button
              key={template.key}
              type="button"
              onClick={() => setForm({ ...form, template: template.key })}
              className={`rounded-lg border px-3 py-2 text-left transition-colors ${
                form.template === template.key
                  ? "border-blue-500/50 bg-blue-500/10"
                  : "border-theme-modal-border hover:bg-theme-sidebar-item-hover"
              }`}
            >
              <p className="text-sm font-medium text-theme-text-primary">
                {template.label}
              </p>
              <p className="text-xs text-theme-text-secondary">
                {template.description}
              </p>
            </button>
          ))}
        </div>
      </div>

      <div className="mt-6 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={submit} disabled={saving}>
          {saving ? "Creating…" : "Create agent"}
        </Button>
      </div>
    </Modal>
  );
}

function AgentEdit({ agent, leadFields, onClose, onSaved }) {
  const [form, setForm] = useState({
    name: agent.name ?? "",
    description: agent.description ?? "",
    systemPrompt: agent.workspace?.systemPrompt ?? "",
    temperature: agent.workspace?.temperature ?? 0.2,
    model: agent.workspace?.model ?? "",
    chatMode: agent.workspace?.chatMode ?? "query",
    visibility: agent.visibility,
    fallbackMessage: agent.fallbackMessage ?? "",
    leadCapture: agent.leadCapture,
    leadCaptureFields: agent.leadCaptureFields ?? [],
    escalation: agent.escalation,
    escalationTarget: agent.escalationTarget ?? "",
    active: agent.active,
  });
  const [saving, setSaving] = useState(false);

  async function submit() {
    setSaving(true);
    const result = await Business.agents.update(agent.uuid, form);
    setSaving(false);
    if (result?.error) return showToast(result.error, "error");
    showToast("Agent saved.", "success");
    onSaved();
  }

  async function remove() {
    if (
      !window.confirm(
        "Remove this agent? Its documents and conversation history are kept."
      )
    )
      return;
    const result = await Business.agents.delete(agent.uuid);
    if (result?.error) return showToast(result.error, "error");
    showToast("Agent removed. Its knowledge was retained.", "success");
    onSaved();
  }

  function toggleField(field) {
    const next = form.leadCaptureFields.includes(field)
      ? form.leadCaptureFields.filter((f) => f !== field)
      : [...form.leadCaptureFields, field];
    setForm({ ...form, leadCaptureFields: next });
  }

  return (
    <Modal title={`Configure ${agent.name}`} onClose={onClose} wide>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Text
          label="Name"
          value={form.name}
          onChange={(v) => setForm({ ...form, name: v })}
        />
        <Text
          label="Description"
          value={form.description}
          onChange={(v) => setForm({ ...form, description: v })}
        />
      </div>

      <label className="mt-4 block text-sm">
        <span className="text-theme-text-secondary">System instructions</span>
        <textarea
          rows={8}
          value={form.systemPrompt}
          onChange={(e) => setForm({ ...form, systemPrompt: e.target.value })}
          className="mt-1 w-full rounded-lg border border-theme-modal-border bg-theme-bg-primary px-3 py-2 font-mono text-xs text-theme-text-primary"
        />
      </label>

      <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-3">
        <Text
          label="Model (blank = deployment default)"
          value={form.model}
          onChange={(v) => setForm({ ...form, model: v })}
        />
        <label className="block text-sm">
          <span className="text-theme-text-secondary">Temperature</span>
          <input
            type="number"
            step="0.1"
            min="0"
            max="2"
            value={form.temperature}
            onChange={(e) =>
              setForm({ ...form, temperature: Number(e.target.value) })
            }
            className="mt-1 w-full rounded-lg border border-theme-modal-border bg-theme-bg-primary px-3 py-2 text-theme-text-primary"
          />
        </label>
        <label className="block text-sm">
          <span className="text-theme-text-secondary">Answer style</span>
          <select
            value={form.chatMode}
            onChange={(e) => setForm({ ...form, chatMode: e.target.value })}
            className="mt-1 w-full rounded-lg border border-theme-modal-border bg-theme-bg-primary px-3 py-2 text-theme-text-primary"
          >
            <option value="query">Only answer from company knowledge</option>
            <option value="chat">Allow general knowledge too</option>
          </select>
        </label>
      </div>

      <label className="mt-4 block text-sm">
        <span className="text-theme-text-secondary">
          Fallback when the answer is not in your knowledge
        </span>
        <input
          value={form.fallbackMessage}
          onChange={(e) =>
            setForm({ ...form, fallbackMessage: e.target.value })
          }
          className="mt-1 w-full rounded-lg border border-theme-modal-border bg-theme-bg-primary px-3 py-2 text-theme-text-primary"
        />
      </label>

      <div className="mt-5 grid grid-cols-1 gap-4 md:grid-cols-2">
        <div className="rounded-lg border border-theme-modal-border p-3">
          <Toggle
            label="Capture leads"
            checked={form.leadCapture}
            onChange={(v) => setForm({ ...form, leadCapture: v })}
          />
          {form.leadCapture && (
            <div className="mt-3">
              <p className="text-xs text-theme-text-secondary">
                Required fields
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                {leadFields.map((field) => (
                  <button
                    key={field}
                    type="button"
                    onClick={() => toggleField(field)}
                    className={`rounded-full border px-2.5 py-1 text-xs ${
                      form.leadCaptureFields.includes(field)
                        ? "border-blue-500/50 bg-blue-500/10 text-blue-300"
                        : "border-theme-modal-border text-theme-text-secondary"
                    }`}
                  >
                    {field.replace(/_/g, " ")}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="rounded-lg border border-theme-modal-border p-3">
          <Toggle
            label="Allow escalation to a human"
            checked={form.escalation}
            onChange={(v) => setForm({ ...form, escalation: v })}
          />
          {form.escalation && (
            <p className="mt-2 text-xs text-theme-text-secondary">
              Escalations are delivered through your configured integrations on
              the Integrations page.
            </p>
          )}
        </div>
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-6">
        <Toggle
          label="Agent is active"
          checked={form.active}
          onChange={(v) => setForm({ ...form, active: v })}
        />
        <label className="flex items-center gap-2 text-sm text-theme-text-secondary">
          Audience
          <select
            value={form.visibility}
            onChange={(e) => setForm({ ...form, visibility: e.target.value })}
            className="rounded-lg border border-theme-modal-border bg-theme-bg-primary px-3 py-1.5 text-theme-text-primary"
          >
            <option value="private">Internal only</option>
            <option value="public">Website visitors</option>
          </select>
        </label>
      </div>

      <div className="mt-6 flex justify-between">
        <Button variant="danger" onClick={remove}>
          Remove agent
        </Button>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={saving}>
            {saving ? "Saving…" : "Save changes"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

export function Modal({ title, onClose, children, wide = false }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div
        className={`max-h-[88vh] w-full overflow-y-auto rounded-xl border border-theme-modal-border bg-theme-bg-secondary p-6 ${
          wide ? "max-w-3xl" : "max-w-xl"
        }`}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-theme-text-primary">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-theme-text-secondary hover:text-theme-text-primary"
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Text({ label, value, onChange, placeholder = "" }) {
  return (
    <label className="block text-sm">
      <span className="text-theme-text-secondary">{label}</span>
      <input
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full rounded-lg border border-theme-modal-border bg-theme-bg-primary px-3 py-2 text-theme-text-primary"
      />
    </label>
  );
}

export function Toggle({ label, checked, onChange }) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-sm text-theme-text-primary">
      <input
        type="checkbox"
        checked={!!checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 rounded border-theme-modal-border"
      />
      {label}
    </label>
  );
}

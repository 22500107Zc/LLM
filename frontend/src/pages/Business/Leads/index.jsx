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

const STATUS_TONE = {
  new: "info",
  qualified: "success",
  contacted: "neutral",
  opportunity: "success",
  closed: "neutral",
  disqualified: "danger",
};

export default function LeadsPage() {
  const [data, setData] = useState(null);
  const [escalations, setEscalations] = useState([]);
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(null);

  async function load() {
    setLoading(true);
    const [leadResult, escalationResult] = await Promise.all([
      Business.leads.all(status ? { status } : {}),
      Business.escalations.all({}),
    ]);
    if (leadResult?.error) setError(leadResult.error);
    else setData(leadResult);
    setEscalations(escalationResult?.escalations ?? []);
    setLoading(false);
  }

  useEffect(() => {
    load();
  }, [status]);

  async function changeStatus(uuid, next) {
    const result = await Business.leads.setStatus(uuid, next);
    if (result?.error) return showToast(result.error, "error");
    showToast("Lead updated.", "success");
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
          title="Leads"
          description="People who asked to be contacted, captured by your AI agents."
          loading={loading}
          error={error}
          actions={
            <Button
              variant="secondary"
              onClick={() => Business.leads.exportCsv(status || null)}
            >
              Export CSV
            </Button>
          }
        >
          <div className="flex flex-wrap gap-2">
            <FilterChip active={status === ""} onClick={() => setStatus("")}>
              All ({data?.total ?? 0})
            </FilterChip>
            {(data?.statuses ?? []).map((value) => (
              <FilterChip
                key={value}
                active={status === value}
                onClick={() => setStatus(value)}
              >
                {value} ({data?.counts?.[value] ?? 0})
              </FilterChip>
            ))}
          </div>

          <Card>
            <Table
              empty="No leads captured yet. Enable lead capture on a website agent to start collecting them."
              columns={[
                {
                  key: "contact",
                  label: "Contact",
                  render: (lead) => (
                    <div>
                      <p className="font-medium">
                        {[lead.first_name, lead.last_name]
                          .filter(Boolean)
                          .join(" ") || "—"}
                      </p>
                      <p className="text-xs text-theme-text-secondary">
                        {lead.email}
                      </p>
                    </div>
                  ),
                },
                { key: "company", label: "Company" },
                {
                  key: "reason",
                  label: "Reason",
                  render: (lead) => (
                    <span className="line-clamp-2 text-xs">
                      {lead.reason ?? lead.conversation_summary ?? "—"}
                    </span>
                  ),
                },
                {
                  key: "createdAt",
                  label: "Captured",
                  render: (lead) => new Date(lead.createdAt).toLocaleString(),
                },
                {
                  key: "status",
                  label: "Status",
                  render: (lead) => (
                    <select
                      value={lead.status}
                      onChange={(event) =>
                        changeStatus(lead.uuid, event.target.value)
                      }
                      className="rounded border border-theme-modal-border bg-theme-bg-primary px-2 py-1 text-xs text-theme-text-primary"
                    >
                      {(data?.statuses ?? []).map((value) => (
                        <option key={value} value={value}>
                          {value}
                        </option>
                      ))}
                    </select>
                  ),
                },
                {
                  key: "actions",
                  label: "",
                  render: (lead) => (
                    <button
                      type="button"
                      onClick={() => setSelected(lead)}
                      className="text-xs underline text-theme-text-secondary hover:text-theme-text-primary"
                    >
                      Details
                    </button>
                  ),
                },
              ]}
              rows={data?.leads ?? []}
            />
          </Card>

          <Card title={`Human escalations (${escalations.length})`}>
            <Table
              empty="No escalations. When a visitor asks for a person, it will appear here."
              columns={[
                {
                  key: "contact_name",
                  label: "Contact",
                  render: (row) => (
                    <div>
                      <p className="font-medium">
                        {row.contact_name ?? "Anonymous"}
                      </p>
                      <p className="text-xs text-theme-text-secondary">
                        {row.contact_email ?? "—"}
                      </p>
                    </div>
                  ),
                },
                {
                  key: "question",
                  label: "Question",
                  render: (row) => (
                    <span className="line-clamp-2 text-xs">
                      {row.question ?? "—"}
                    </span>
                  ),
                },
                { key: "reason", label: "Reason" },
                {
                  key: "createdAt",
                  label: "Raised",
                  render: (row) => new Date(row.createdAt).toLocaleString(),
                },
                {
                  key: "status",
                  label: "Status",
                  render: (row) => (
                    <select
                      value={row.status}
                      onChange={async (event) => {
                        const result = await Business.escalations.setStatus(
                          row.uuid,
                          event.target.value
                        );
                        if (result?.error)
                          return showToast(result.error, "error");
                        load();
                      }}
                      className="rounded border border-theme-modal-border bg-theme-bg-primary px-2 py-1 text-xs text-theme-text-primary"
                    >
                      {["open", "acknowledged", "resolved", "dismissed"].map(
                        (value) => (
                          <option key={value} value={value}>
                            {value}
                          </option>
                        )
                      )}
                    </select>
                  ),
                },
                {
                  key: "delivered",
                  label: "Delivered",
                  render: (row) =>
                    row.delivered ? (
                      <Badge tone="success">sent</Badge>
                    ) : (
                      <button
                        type="button"
                        onClick={async () => {
                          const result = await Business.escalations.redeliver(
                            row.uuid
                          );
                          if (result?.error)
                            return showToast(result.error, "error");
                          showToast("Re-sent.", "success");
                          load();
                        }}
                        className="text-xs underline text-theme-text-secondary"
                      >
                        retry
                      </button>
                    ),
                },
              ]}
              rows={escalations}
            />
          </Card>

          {selected && (
            <LeadDetail
              lead={selected}
              onClose={() => setSelected(null)}
              onChanged={load}
            />
          )}
        </BusinessPage>
      </div>
    </div>
  );
}

function FilterChip({ active, onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full border px-3 py-1 text-xs capitalize transition-colors ${
        active
          ? "border-blue-500/40 bg-blue-500/10 text-blue-300"
          : "border-theme-modal-border text-theme-text-secondary hover:bg-theme-sidebar-item-hover"
      }`}
    >
      {children}
    </button>
  );
}

function LeadDetail({ lead, onClose, onChanged }) {
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  async function addNote() {
    if (!note.trim()) return;
    setSaving(true);
    const result = await Business.leads.addNote(lead.uuid, note);
    setSaving(false);
    if (result?.error) return showToast(result.error, "error");
    setNote("");
    showToast("Note added.", "success");
    onChanged();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-xl border border-theme-modal-border bg-theme-bg-secondary p-6">
        <div className="mb-4 flex items-start justify-between">
          <div>
            <h2 className="text-lg font-semibold text-theme-text-primary">
              {[lead.first_name, lead.last_name].filter(Boolean).join(" ") ||
                "Lead"}
            </h2>
            <p className="text-sm text-theme-text-secondary">{lead.email}</p>
          </div>
          <Badge tone={STATUS_TONE[lead.status] ?? "neutral"}>
            {lead.status}
          </Badge>
        </div>

        <dl className="grid grid-cols-2 gap-3 text-sm">
          <Field label="Company" value={lead.company} />
          <Field label="Phone" value={lead.phone} />
          <Field label="Job title" value={lead.job_title} />
          <Field
            label="Captured"
            value={new Date(lead.createdAt).toLocaleString()}
          />
          <Field label="Source page" value={lead.source_url} full />
          <Field label="Reason for inquiry" value={lead.reason} full />
          <Field
            label="Conversation summary"
            value={lead.conversation_summary}
            full
          />
        </dl>

        {lead.notes && (
          <div className="mt-4">
            <p className="text-xs uppercase tracking-wide text-theme-text-secondary">
              Notes
            </p>
            <pre className="mt-1 whitespace-pre-wrap rounded-lg border border-theme-modal-border bg-theme-bg-primary p-3 text-xs text-theme-text-primary">
              {lead.notes}
            </pre>
          </div>
        )}

        <div className="mt-4 flex gap-2">
          <input
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="Add a note…"
            className="flex-1 rounded-lg border border-theme-modal-border bg-theme-bg-primary px-3 py-2 text-sm text-theme-text-primary"
          />
          <Button onClick={addNote} disabled={saving || !note.trim()}>
            {saving ? "Saving…" : "Add note"}
          </Button>
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, value, full = false }) {
  return (
    <div className={full ? "col-span-2" : ""}>
      <dt className="text-xs uppercase tracking-wide text-theme-text-secondary">
        {label}
      </dt>
      <dd className="text-theme-text-primary break-words">{value || "—"}</dd>
    </div>
  );
}

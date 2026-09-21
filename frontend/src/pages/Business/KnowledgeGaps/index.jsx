import React, { useEffect, useState } from "react";
import Sidebar from "@/components/SettingsSidebar";
import { isMobile } from "react-device-detect";
import Business from "@/models/business";
import BusinessPage, {
  Card,
  Table,
  Badge,
  EmptyState,
} from "@/components/Business/Layout";
import showToast from "@/utils/toast";

const REASON_LABEL = {
  no_sources: "No document found",
  refusal: "AI could not answer",
  low_confidence: "Low confidence",
  negative_feedback: "Rated unhelpful",
  escalated: "Escalated to a human",
};

export default function KnowledgeGapsPage() {
  const [data, setData] = useState(null);
  const [status, setStatus] = useState("open");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  async function load() {
    setLoading(true);
    const result = await Business.knowledgeGaps.all({ status });
    if (result?.error) setError(result.error);
    else setData(result);
    setLoading(false);
  }

  useEffect(() => {
    load();
  }, [status]);

  async function update(id, patch) {
    const result = await Business.knowledgeGaps.update(id, patch);
    if (result?.error) return showToast(result.error, "error");
    showToast("Updated.", "success");
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
          title="Knowledge Gaps"
          description="Questions your AI could not answer from approved company knowledge, grouped by topic."
          loading={loading}
          error={error}
          actions={
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              className="rounded-lg border border-theme-modal-border bg-theme-bg-primary px-3 py-2 text-sm text-theme-text-primary"
            >
              <option value="open">Open</option>
              <option value="in_progress">In progress</option>
              <option value="resolved">Resolved</option>
              <option value="dismissed">Dismissed</option>
              <option value="all">All</option>
            </select>
          }
        >
          {!data?.gaps?.length ? (
            <EmptyState
              title="No knowledge gaps found"
              description="When your AI cannot answer a question from approved knowledge, or a user rates an answer unhelpful, it will show up here grouped by topic."
            />
          ) : (
            <Card>
              <Table
                columns={[
                  {
                    key: "question",
                    label: "Question / topic",
                    render: (gap) => (
                      <div>
                        <p className="font-medium">{gap.question}</p>
                        <div className="mt-1 flex flex-wrap gap-1">
                          {(gap.reasons ?? []).map((reason) => (
                            <Badge key={reason} tone="warning">
                              {REASON_LABEL[reason] ?? reason}
                            </Badge>
                          ))}
                        </div>
                      </div>
                    ),
                  },
                  { key: "frequency", label: "Times asked" },
                  {
                    key: "agentName",
                    label: "Agent",
                    render: (g) => g.agentName ?? "—",
                  },
                  {
                    key: "lastSeenAt",
                    label: "Last asked",
                    render: (g) => new Date(g.lastSeenAt).toLocaleString(),
                  },
                  {
                    key: "suggested_action",
                    label: "Suggested action",
                    render: (g) => (
                      <span className="text-xs">
                        {g.suggested_action ?? "—"}
                      </span>
                    ),
                  },
                  {
                    key: "status",
                    label: "Status",
                    render: (gap) => (
                      <select
                        value={gap.status}
                        onChange={(e) =>
                          update(gap.id, { status: e.target.value })
                        }
                        className="rounded border border-theme-modal-border bg-theme-bg-primary px-2 py-1 text-xs text-theme-text-primary"
                      >
                        {(data.statuses ?? []).map((value) => (
                          <option key={value} value={value}>
                            {value.replace(/_/g, " ")}
                          </option>
                        ))}
                      </select>
                    ),
                  },
                  {
                    key: "note",
                    label: "Note",
                    render: (gap) => (
                      <button
                        type="button"
                        onClick={() => {
                          const note = window.prompt(
                            "Internal note for this knowledge gap:",
                            gap.note ?? ""
                          );
                          if (note === null) return;
                          update(gap.id, { note });
                        }}
                        className="text-xs underline text-theme-text-secondary hover:text-theme-text-primary"
                      >
                        {gap.note ? "Edit note" : "Add note"}
                      </button>
                    ),
                  },
                ]}
                rows={data.gaps}
              />
            </Card>
          )}
        </BusinessPage>
      </div>
    </div>
  );
}

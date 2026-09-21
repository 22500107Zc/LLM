import React, { useEffect, useState } from "react";
import Sidebar from "@/components/SettingsSidebar";
import { isMobile } from "react-device-detect";
import Business from "@/models/business";
import BusinessPage, {
  Badge,
  Card,
  Table,
  EmptyState,
} from "@/components/Business/Layout";
import showToast from "@/utils/toast";

/**
 * Company knowledge. Upload and embedding are handled by the existing document
 * pipeline; this view presents processing state and per-agent assignment in
 * business terms.
 */
export default function KnowledgePage() {
  const [data, setData] = useState(null);
  const [agents, setAgents] = useState([]);
  const [agentFilter, setAgentFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  async function load() {
    setLoading(true);
    const [result, agentResult] = await Promise.all([
      Business.knowledge.all(agentFilter || null),
      Business.agents.all(),
    ]);
    if (result?.error) setError(result.error);
    else setData(result);
    setAgents(agentResult?.agents ?? []);
    setLoading(false);
  }

  useEffect(() => {
    load();
  }, [agentFilter]);

  return (
    <div className="w-screen h-screen overflow-hidden bg-theme-bg-container flex">
      <Sidebar />
      <div
        style={{ height: isMobile ? "100%" : "calc(100% - 32px)" }}
        className="relative md:ml-[2px] md:mr-[16px] md:my-[16px] md:rounded-[16px] bg-theme-bg-secondary w-full h-full overflow-y-scroll"
      >
        <BusinessPage
          title="Knowledge"
          description="The company documents your AI answers from. Answers cite these sources."
          loading={loading}
          error={error}
          actions={
            <select
              value={agentFilter}
              onChange={(e) => setAgentFilter(e.target.value)}
              className="rounded-lg border border-theme-modal-border bg-theme-bg-primary px-3 py-2 text-sm text-theme-text-primary"
            >
              <option value="">All agents</option>
              {agents.map((agent) => (
                <option key={agent.uuid} value={agent.uuid}>
                  {agent.name}
                </option>
              ))}
            </select>
          }
        >
          <div className="rounded-lg border border-theme-modal-border bg-theme-bg-primary px-4 py-3 text-sm text-theme-text-secondary">
            To add documents, open an agent&apos;s workspace and use{" "}
            <strong className="text-theme-text-primary">
              Manage Documents
            </strong>
            . Uploads are processed, split and embedded automatically; PDFs,
            DOCX, TXT, CSV and web pages are supported.
          </div>

          {data?.failed > 0 && (
            <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-300">
              {data.failed} document{data.failed === 1 ? "" : "s"} failed to
              process. Use Re-process to try again.
            </div>
          )}

          {!data?.documents?.length ? (
            <EmptyState
              title="No company knowledge yet"
              description="Until you add documents, your agents can only say they do not have the information. Upload your policies, product details and FAQs to get useful answers."
            />
          ) : (
            <Card title={`Documents (${data.total})`}>
              <Table
                columns={[
                  {
                    key: "title",
                    label: "Document",
                    render: (doc) => (
                      <div>
                        <p className="font-medium">{doc.title}</p>
                        <p className="text-xs text-theme-text-secondary">
                          {doc.source}
                        </p>
                      </div>
                    ),
                  },
                  {
                    key: "agent",
                    label: "Used by",
                    render: (doc) => doc.agent?.name ?? "Unassigned",
                  },
                  {
                    key: "wordCount",
                    label: "Size",
                    render: (doc) =>
                      doc.wordCount
                        ? `${doc.wordCount.toLocaleString()} words`
                        : "—",
                  },
                  {
                    key: "status",
                    label: "Status",
                    render: (doc) => (
                      <Badge
                        tone={doc.status === "failed" ? "danger" : "success"}
                      >
                        {doc.status === "failed" ? "Failed" : "Ready"}
                      </Badge>
                    ),
                  },
                  {
                    key: "watched",
                    label: "Auto-refresh",
                    render: (doc) =>
                      doc.watched ? <Badge tone="info">On</Badge> : "—",
                  },
                  {
                    key: "lastUpdatedAt",
                    label: "Last updated",
                    render: (doc) =>
                      new Date(
                        doc.lastUpdatedAt ?? doc.createdAt
                      ).toLocaleDateString(),
                  },
                  {
                    key: "actions",
                    label: "",
                    render: (doc) => (
                      <button
                        type="button"
                        onClick={async () => {
                          showToast("Re-processing…", "info");
                          const result = await Business.knowledge.reingest(
                            doc.docId
                          );
                          if (!result?.success)
                            return showToast(
                              result?.error ?? "Could not re-process.",
                              "error"
                            );
                          showToast("Document re-processed.", "success");
                          load();
                        }}
                        className="text-xs underline text-theme-text-secondary hover:text-theme-text-primary"
                      >
                        Re-process
                      </button>
                    ),
                  },
                ]}
                rows={data.documents}
              />
            </Card>
          )}

          <p className="text-xs text-theme-text-secondary">
            Storage included with your plan:{" "}
            {data?.limits?.storageLimitGb ?? 25} GB.
          </p>
        </BusinessPage>
      </div>
    </div>
  );
}

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
import { Modal } from "../Agents";
import showToast from "@/utils/toast";

export default function ConversationsPage() {
  const [filters, setFilters] = useState({
    channel: "",
    search: "",
    days: "30",
  });
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [open, setOpen] = useState(null);

  async function load() {
    setLoading(true);
    const params = {};
    if (filters.channel) params.channel = filters.channel;
    if (filters.search) params.search = filters.search;
    if (filters.days) params.days = filters.days;
    const result = await Business.conversations.all(params);
    if (result?.error) setError(result.error);
    else setData(result);
    setLoading(false);
  }

  useEffect(() => {
    load();
  }, [filters.channel, filters.days]);

  async function openTranscript(row) {
    const result = await Business.conversations.transcript(
      row.channel,
      row.referenceId
    );
    if (result?.error) return showToast(result.error, "error");
    setOpen(result.conversation);
  }

  async function markReviewed(row, reviewed) {
    const result = await Business.conversations.review(
      row.channel,
      row.referenceId,
      {
        reviewed,
      }
    );
    if (result?.error) return showToast(result.error, "error");
    showToast(reviewed ? "Marked reviewed." : "Marked unreviewed.", "success");
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
          title="Conversations"
          description="Everything your AI has discussed, internally and on your website."
          loading={loading}
          error={error}
          actions={
            <Button
              variant="secondary"
              onClick={() =>
                Business.conversations.exportCsv({
                  ...(filters.channel ? { channel: filters.channel } : {}),
                  ...(filters.days ? { days: filters.days } : {}),
                })
              }
            >
              Export CSV
            </Button>
          }
        >
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={filters.channel}
              onChange={(e) =>
                setFilters({ ...filters, channel: e.target.value })
              }
              className="rounded-lg border border-theme-modal-border bg-theme-bg-primary px-3 py-2 text-sm text-theme-text-primary"
            >
              <option value="">All channels</option>
              <option value="internal">Internal</option>
              <option value="public">Website</option>
            </select>
            <select
              value={filters.days}
              onChange={(e) => setFilters({ ...filters, days: e.target.value })}
              className="rounded-lg border border-theme-modal-border bg-theme-bg-primary px-3 py-2 text-sm text-theme-text-primary"
            >
              <option value="7">Last 7 days</option>
              <option value="30">Last 30 days</option>
              <option value="90">Last 90 days</option>
              <option value="">All time</option>
            </select>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                load();
              }}
              className="flex flex-1 gap-2"
            >
              <input
                value={filters.search}
                onChange={(e) =>
                  setFilters({ ...filters, search: e.target.value })
                }
                placeholder="Search message text…"
                className="flex-1 rounded-lg border border-theme-modal-border bg-theme-bg-primary px-3 py-2 text-sm text-theme-text-primary"
              />
              <Button type="submit" variant="secondary">
                Search
              </Button>
            </form>
          </div>

          <Card>
            <Table
              empty="No conversations in this period."
              columns={[
                {
                  key: "startedAt",
                  label: "When",
                  render: (row) => (
                    <div className="text-xs">
                      <p>{new Date(row.startedAt).toLocaleDateString()}</p>
                      <p className="text-theme-text-secondary">
                        {new Date(row.startedAt).toLocaleTimeString()}
                      </p>
                    </div>
                  ),
                },
                { key: "agentName", label: "Agent" },
                {
                  key: "channel",
                  label: "Channel",
                  render: (row) => (
                    <Badge tone={row.channel === "public" ? "info" : "neutral"}>
                      {row.channel === "public" ? "Website" : "Internal"}
                    </Badge>
                  ),
                },
                { key: "visitor", label: "Who" },
                { key: "messageCount", label: "Messages" },
                {
                  key: "signals",
                  label: "Outcome",
                  render: (row) => (
                    <div className="flex flex-wrap gap-1">
                      {row.leadGenerated && <Badge tone="success">Lead</Badge>}
                      {row.escalated && <Badge tone="warning">Escalated</Badge>}
                      {row.feedback?.negative > 0 && (
                        <Badge tone="danger">{row.feedback.negative} 👎</Badge>
                      )}
                      {row.feedback?.positive > 0 && (
                        <Badge tone="success">{row.feedback.positive} 👍</Badge>
                      )}
                      {!row.leadGenerated &&
                        !row.escalated &&
                        !row.feedback?.negative &&
                        !row.feedback?.positive &&
                        "—"}
                    </div>
                  ),
                },
                {
                  key: "reviewed",
                  label: "Reviewed",
                  render: (row) => (
                    <button
                      type="button"
                      onClick={() => markReviewed(row, !row.reviewed)}
                      className="text-xs underline text-theme-text-secondary hover:text-theme-text-primary"
                    >
                      {row.reviewed ? "Yes" : "Mark reviewed"}
                    </button>
                  ),
                },
                {
                  key: "actions",
                  label: "",
                  render: (row) => (
                    <button
                      type="button"
                      onClick={() => openTranscript(row)}
                      className="text-xs underline text-theme-text-secondary hover:text-theme-text-primary"
                    >
                      Transcript
                    </button>
                  ),
                },
              ]}
              rows={data?.conversations ?? []}
            />
            {data?.total > (data?.conversations?.length ?? 0) && (
              <p className="mt-3 text-center text-xs text-theme-text-secondary">
                Showing {data.conversations.length} of {data.total}. Narrow the
                filters to see more.
              </p>
            )}
          </Card>

          {open && (
            <Modal
              title="Conversation transcript"
              onClose={() => setOpen(null)}
              wide
            >
              <div className="mb-3 flex flex-wrap gap-2 text-xs text-theme-text-secondary">
                <span>{open.agentName}</span>
                <span>·</span>
                <span>{open.visitor}</span>
                {open.sourceHost && (
                  <>
                    <span>·</span>
                    <span>{open.sourceHost}</span>
                  </>
                )}
              </div>
              <p className="mb-4 rounded-lg border border-theme-modal-border bg-theme-bg-primary p-3 text-sm text-theme-text-primary">
                {open.summary}
              </p>
              <div className="space-y-3">
                {(open.turns ?? []).map((turn, index) => (
                  <div key={index} className="space-y-2">
                    <div className="rounded-lg bg-theme-bg-primary p-3">
                      <p className="text-xs uppercase text-theme-text-secondary">
                        Question
                      </p>
                      <p className="text-sm text-theme-text-primary">
                        {turn.prompt}
                      </p>
                    </div>
                    <div className="rounded-lg border border-theme-modal-border p-3">
                      <p className="text-xs uppercase text-theme-text-secondary">
                        Answer
                      </p>
                      <p className="whitespace-pre-wrap text-sm text-theme-text-primary">
                        {turn.answer}
                      </p>
                      {!!turn.sources?.length && (
                        <p className="mt-2 text-xs text-theme-text-secondary">
                          Sources:{" "}
                          {turn.sources
                            .map((s) => s?.title ?? s?.metadata?.title)
                            .filter(Boolean)
                            .join(", ")}
                        </p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </Modal>
          )}
        </BusinessPage>
      </div>
    </div>
  );
}

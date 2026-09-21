import React, { useEffect, useState } from "react";
import Sidebar from "@/components/SettingsSidebar";
import { isMobile } from "react-device-detect";
import Business from "@/models/business";
import BusinessPage, { Card, Stat, Table } from "@/components/Business/Layout";

/** Business analytics. Every figure is measured; estimates are labelled. */
export default function AnalyticsPage() {
  const [days, setDays] = useState(30);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    (async () => {
      setLoading(true);
      const result = await Business.analytics(days);
      if (result?.error) setError(result.error);
      else setData(result);
      setLoading(false);
    })();
  }, [days]);

  return (
    <div className="w-screen h-screen overflow-hidden bg-theme-bg-container flex">
      <Sidebar />
      <div
        style={{ height: isMobile ? "100%" : "calc(100% - 32px)" }}
        className="relative md:ml-[2px] md:mr-[16px] md:my-[16px] md:rounded-[16px] bg-theme-bg-secondary w-full h-full overflow-y-scroll"
      >
        <BusinessPage
          title="Analytics"
          description="How your AI is being used, and how well it is answering."
          loading={loading}
          error={error}
          actions={
            <div className="flex gap-1 rounded-lg border border-theme-modal-border p-1">
              {[7, 30, 90].map((value) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setDays(value)}
                  className={`rounded px-3 py-1 text-xs transition-colors ${
                    days === value
                      ? "bg-theme-button-primary text-white"
                      : "text-theme-text-secondary hover:bg-theme-sidebar-item-hover"
                  }`}
                >
                  {value} days
                </button>
              ))}
            </div>
          }
        >
          {data && (
            <>
              <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
                <Stat label="Conversations" value={data.conversations.total} />
                <Stat label="Internal" value={data.conversations.internal} />
                <Stat label="Website" value={data.conversations.public} />
                <Stat
                  label="AI messages"
                  value={data.conversations.aiMessages}
                />
                <Stat
                  label="Unique visitors"
                  value={data.conversations.uniqueVisitors}
                  estimate={data.conversations.uniqueVisitorsIsEstimate}
                  hint="distinct website sessions"
                />
                <Stat label="Leads captured" value={data.leads.captured} />
                <Stat label="Qualified leads" value={data.leads.qualified} />
                <Stat
                  label="Lead conversion"
                  value={`${data.leads.conversionPercent}%`}
                  hint="qualified ÷ captured"
                />
                <Stat label="Escalations" value={data.escalations.total} />
                <Stat
                  label="Escalation rate"
                  value={`${data.escalations.ratePercent}%`}
                />
                <Stat label="Answered" value={data.answers.answered} />
                <Stat label="Unanswered" value={data.answers.unanswered} />
                <Stat
                  label="Answer rate"
                  value={`${data.answers.answeredPercent}%`}
                />
                <Stat
                  label="Positive feedback"
                  value={data.answers.positiveFeedback}
                />
                <Stat
                  label="Negative feedback"
                  value={data.answers.negativeFeedback}
                />
                <Stat
                  label="Open knowledge gaps"
                  value={data.knowledge.openGaps}
                />
                <Stat
                  label="Automation runs"
                  value={data.automations.executions}
                />
                <Stat
                  label="Automation failures"
                  value={data.automations.failures}
                />
              </div>

              <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
                <Card title="Top questions">
                  <Table
                    empty="No questions in this period."
                    columns={[
                      { key: "question", label: "Question" },
                      { key: "count", label: "Asked" },
                    ]}
                    rows={data.topQuestions}
                  />
                </Card>

                <Card title="Most used knowledge sources">
                  <Table
                    empty="No sources cited in this period."
                    columns={[
                      { key: "title", label: "Document" },
                      { key: "count", label: "Citations" },
                    ]}
                    rows={data.knowledge.popularSources}
                  />
                </Card>

                <Card title="Agent usage">
                  <Table
                    empty="No agent activity in this period."
                    columns={[
                      { key: "name", label: "Agent" },
                      { key: "internal", label: "Internal" },
                      { key: "public", label: "Website" },
                    ]}
                    rows={data.agentUsage}
                  />
                </Card>

                <Card title="Team usage">
                  <Table
                    empty="No internal usage in this period."
                    columns={[
                      { key: "username", label: "User" },
                      { key: "messages", label: "Messages" },
                    ]}
                    rows={data.userUsage}
                  />
                </Card>
              </div>

              <p className="text-xs text-theme-text-secondary">
                Figures cover {data.window.days} days. Metrics marked
                &ldquo;Estimated&rdquo; are proxies, not exact measurements. No
                financial return figures are calculated.
              </p>
            </>
          )}
        </BusinessPage>
      </div>
    </div>
  );
}

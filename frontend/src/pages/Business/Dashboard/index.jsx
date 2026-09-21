import React, { useEffect, useState } from "react";
import Sidebar from "@/components/SettingsSidebar";
import { isMobile } from "react-device-detect";
import { Link } from "react-router-dom";
import Business from "@/models/business";
import paths from "@/utils/paths";
import { companyName } from "@/business/brand";
import BusinessPage, { Card, Stat, Badge } from "@/components/Business/Layout";

/** The business overview: what the AI has been doing and what needs attention. */
export default function BusinessDashboard() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    (async () => {
      const result = await Business.dashboard();
      if (result?.error) setError(result.error);
      else setData(result);
      setLoading(false);
    })();
  }, []);

  const metrics = data?.metrics;
  const onboarding = data?.onboarding;

  return (
    <div className="w-screen h-screen overflow-hidden bg-theme-bg-container flex">
      <Sidebar />
      <div
        style={{ height: isMobile ? "100%" : "calc(100% - 32px)" }}
        className="relative md:ml-[2px] md:mr-[16px] md:my-[16px] md:rounded-[16px] bg-theme-bg-secondary w-full h-full overflow-y-scroll"
      >
        <BusinessPage
          title="Dashboard"
          description={`What your AI has handled for ${companyName()} over the last 30 days.`}
          loading={loading}
          error={error}
        >
          {data?.billing && data.billing.access !== "ok" && (
            <Link
              to={paths.business.billing()}
              className={`block rounded-lg border px-4 py-3 text-sm ${
                data.billing.access === "restricted"
                  ? "border-red-500/40 bg-red-500/10 text-red-300"
                  : "border-amber-500/40 bg-amber-500/10 text-amber-300"
              }`}
            >
              <span className="font-medium">{data.billing.statusLabel}</span> —{" "}
              {data.billing.message} Go to Billing →
            </Link>
          )}

          {onboarding && !onboarding.finished && (
            <Card title="Getting started">
              <div className="mb-3 flex items-center justify-between">
                <p className="text-sm text-theme-text-secondary">
                  {onboarding.completed} of {onboarding.total} steps complete
                </p>
                <Badge tone="info">{onboarding.percent}%</Badge>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-theme-bg-primary">
                <div
                  className="h-full rounded-full bg-blue-500 transition-all"
                  style={{ width: `${onboarding.percent}%` }}
                />
              </div>
              <ul className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
                {onboarding.steps
                  .filter((step) => !step.complete)
                  .slice(0, 6)
                  .map((step) => (
                    <li
                      key={step.key}
                      className="rounded-lg border border-theme-modal-border px-3 py-2 text-sm"
                    >
                      <p className="font-medium text-theme-text-primary">
                        {step.title}
                      </p>
                      <p className="text-xs text-theme-text-secondary">
                        {step.description}
                      </p>
                    </li>
                  ))}
              </ul>
            </Card>
          )}

          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <Stat
              label="AI messages"
              value={metrics?.aiMessages ?? 0}
              hint="Last 30 days"
            />
            <Stat
              label="New leads"
              value={metrics?.newLeads ?? 0}
              hint="Last 30 days"
            />
            <Stat
              label="Open escalations"
              value={metrics?.openEscalations ?? 0}
            />
            <Stat
              label="Knowledge gaps"
              value={metrics?.openKnowledgeGaps ?? 0}
            />
            <Stat
              label="Internal messages"
              value={metrics?.internalMessages ?? 0}
            />
            <Stat
              label="Website messages"
              value={metrics?.publicMessages ?? 0}
            />
            <Stat label="Active agents" value={metrics?.activeAgents ?? 0} />
            <Stat label="Documents" value={metrics?.documents ?? 0} />
          </div>

          <Card title="Where to go next">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {[
                [
                  "AI Agents",
                  paths.business.agents(),
                  "Create and tune your assistants",
                ],
                [
                  "Knowledge",
                  paths.business.knowledge(),
                  "Add the documents your AI answers from",
                ],
                [
                  "Leads",
                  paths.business.leads(),
                  "Follow up on captured interest",
                ],
                [
                  "Conversations",
                  paths.business.conversations(),
                  "Review what was said",
                ],
                [
                  "Knowledge Gaps",
                  paths.business.knowledgeGaps(),
                  "See what your AI could not answer",
                ],
                [
                  "AI Quality",
                  paths.business.quality(),
                  "Test business-critical answers",
                ],
              ].map(([label, href, description]) => (
                <Link
                  key={href}
                  to={href}
                  className="rounded-lg border border-theme-modal-border px-4 py-3 transition-colors hover:bg-theme-sidebar-item-hover"
                >
                  <p className="text-sm font-medium text-theme-text-primary">
                    {label}
                  </p>
                  <p className="text-xs text-theme-text-secondary">
                    {description}
                  </p>
                </Link>
              ))}
            </div>
          </Card>
        </BusinessPage>
      </div>
    </div>
  );
}

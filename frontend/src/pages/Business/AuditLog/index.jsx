import React, { useEffect, useState } from "react";
import Sidebar from "@/components/SettingsSidebar";
import { isMobile } from "react-device-detect";
import Business from "@/models/business";
import BusinessPage, { Card, Table, Badge } from "@/components/Business/Layout";

export default function AuditLogPage() {
  const [data, setData] = useState(null);
  const [category, setCategory] = useState("all");
  const [days, setDays] = useState("30");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    (async () => {
      setLoading(true);
      const result = await Business.audit({
        ...(category !== "all" ? { category } : {}),
        ...(days ? { days } : {}),
        limit: 200,
      });
      if (result?.error) setError(result.error);
      else setData(result);
      setLoading(false);
    })();
  }, [category, days]);

  return (
    <div className="w-screen h-screen overflow-hidden bg-theme-bg-container flex">
      <Sidebar />
      <div
        style={{ height: isMobile ? "100%" : "calc(100% - 32px)" }}
        className="relative md:ml-[2px] md:mr-[16px] md:my-[16px] md:rounded-[16px] bg-theme-bg-secondary w-full h-full overflow-y-scroll"
      >
        <BusinessPage
          title="Audit Log"
          description="A permanent record of who changed what. Credentials and document contents are never recorded."
          loading={loading}
          error={error}
          actions={
            <div className="flex gap-2">
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="rounded-lg border border-theme-modal-border bg-theme-bg-primary px-3 py-2 text-sm capitalize text-theme-text-primary"
              >
                <option value="all">All activity</option>
                {(data?.categories ?? []).map((value) => (
                  <option key={value} value={value}>
                    {value.replace(/_/g, " ")}
                  </option>
                ))}
              </select>
              <select
                value={days}
                onChange={(e) => setDays(e.target.value)}
                className="rounded-lg border border-theme-modal-border bg-theme-bg-primary px-3 py-2 text-sm text-theme-text-primary"
              >
                <option value="7">Last 7 days</option>
                <option value="30">Last 30 days</option>
                <option value="90">Last 90 days</option>
                <option value="">All time</option>
              </select>
            </div>
          }
        >
          <Card>
            <Table
              empty="No activity recorded in this period."
              columns={[
                {
                  key: "occurredAt",
                  label: "When",
                  render: (row) => (
                    <span className="whitespace-nowrap text-xs">
                      {new Date(row.occurredAt).toLocaleString()}
                    </span>
                  ),
                },
                { key: "actor", label: "Who" },
                {
                  key: "action",
                  label: "Action",
                  render: (row) => (
                    <span className="font-mono text-xs">{row.action}</span>
                  ),
                },
                {
                  key: "category",
                  label: "Area",
                  render: (row) => <Badge>{row.category}</Badge>,
                },
                {
                  key: "resource",
                  label: "Resource",
                  render: (row) =>
                    row.resource ? (
                      <span className="text-xs">
                        {row.resource}
                        {row.resourceId
                          ? ` · ${String(row.resourceId).slice(0, 18)}`
                          : ""}
                      </span>
                    ) : (
                      "—"
                    ),
                },
                {
                  key: "metadata",
                  label: "Details",
                  render: (row) =>
                    row.metadata ? (
                      <code className="block max-w-xs overflow-hidden text-ellipsis whitespace-nowrap text-xs text-theme-text-secondary">
                        {JSON.stringify(row.metadata)}
                      </code>
                    ) : (
                      "—"
                    ),
                },
              ]}
              rows={data?.entries ?? []}
            />
            {data?.total > (data?.entries?.length ?? 0) && (
              <p className="mt-3 text-center text-xs text-theme-text-secondary">
                Showing {data.entries.length} of {data.total} entries.
              </p>
            )}
          </Card>
        </BusinessPage>
      </div>
    </div>
  );
}

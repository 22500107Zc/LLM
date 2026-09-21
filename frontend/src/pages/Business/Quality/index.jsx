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

const VERDICT_TONE = {
  passed: "success",
  needs_review: "warning",
  failed: "danger",
};

export default function QualityPage() {
  const [tests, setTests] = useState([]);
  const [runs, setRuns] = useState([]);
  const [agents, setAgents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState(null);
  const [creating, setCreating] = useState(false);
  const [viewing, setViewing] = useState(null);

  async function load() {
    setLoading(true);
    const [testResult, runResult, agentResult] = await Promise.all([
      Business.quality.tests(),
      Business.quality.runs(),
      Business.agents.all(),
    ]);
    if (testResult?.error) setError(testResult.error);
    else setTests(testResult.tests ?? []);
    setRuns(runResult?.runs ?? []);
    setAgents(agentResult?.agents ?? []);
    setLoading(false);
  }

  useEffect(() => {
    load();
  }, []);

  async function runSuite() {
    setRunning(true);
    const result = await Business.quality.run();
    setRunning(false);
    if (result?.error) return showToast(result.error, "error");
    showToast(
      `Run complete: ${result.run.passed} passed, ${result.run.needs_review} need review, ${result.run.failed} failed.`,
      "success"
    );
    load();
  }

  async function openRun(uuid) {
    const result = await Business.quality.runResults(uuid);
    if (result?.error) return showToast(result.error, "error");
    setViewing(result);
  }

  return (
    <div className="w-screen h-screen overflow-hidden bg-theme-bg-container flex">
      <Sidebar />
      <div
        style={{ height: isMobile ? "100%" : "calc(100% - 32px)" }}
        className="relative md:ml-[2px] md:mr-[16px] md:my-[16px] md:rounded-[16px] bg-theme-bg-secondary w-full h-full overflow-y-scroll"
      >
        <BusinessPage
          title="AI Quality"
          description="Regression tests for the answers your business cannot afford to get wrong."
          loading={loading}
          error={error}
          actions={
            <>
              <Button variant="secondary" onClick={() => setCreating(true)}>
                Add test
              </Button>
              <Button onClick={runSuite} disabled={running || !tests.length}>
                {running ? "Running…" : "Run suite"}
              </Button>
            </>
          }
        >
          {!tests.length ? (
            <EmptyState
              title="No quality tests yet"
              description="Add the questions your customers ask most, with the facts a correct answer must contain. Run the suite after changing knowledge or instructions to catch regressions."
              action={
                <Button onClick={() => setCreating(true)}>
                  Add your first test
                </Button>
              }
            />
          ) : (
            <Card title={`Tests (${tests.length})`}>
              <Table
                columns={[
                  { key: "question", label: "Question" },
                  {
                    key: "expectedConcepts",
                    label: "Must mention",
                    render: (test) => (
                      <div className="flex flex-wrap gap-1">
                        {(test.expectedConcepts ?? []).map((concept) => (
                          <Badge key={concept}>{concept}</Badge>
                        ))}
                      </div>
                    ),
                  },
                  {
                    key: "requiredSource",
                    label: "Required source",
                    render: (t) => t.requiredSource ?? "—",
                  },
                  {
                    key: "agent",
                    label: "Agent",
                    render: (t) => t.agent?.name ?? "—",
                  },
                  {
                    key: "actions",
                    label: "",
                    render: (test) => (
                      <button
                        type="button"
                        onClick={async () => {
                          if (!window.confirm("Remove this test?")) return;
                          const result = await Business.quality.deleteTest(
                            test.uuid
                          );
                          if (result?.error)
                            return showToast(result.error, "error");
                          load();
                        }}
                        className="text-xs underline text-red-400"
                      >
                        Remove
                      </button>
                    ),
                  },
                ]}
                rows={tests}
              />
            </Card>
          )}

          <Card title="Run history">
            <Table
              empty="No runs yet."
              columns={[
                {
                  key: "startedAt",
                  label: "Run",
                  render: (run) => new Date(run.startedAt).toLocaleString(),
                },
                { key: "total", label: "Tests" },
                {
                  key: "passed",
                  label: "Passed",
                  render: (r) => <Badge tone="success">{r.passed}</Badge>,
                },
                {
                  key: "needs_review",
                  label: "Needs review",
                  render: (r) => <Badge tone="warning">{r.needs_review}</Badge>,
                },
                {
                  key: "failed",
                  label: "Failed",
                  render: (r) => <Badge tone="danger">{r.failed}</Badge>,
                },
                {
                  key: "actions",
                  label: "",
                  render: (run) => (
                    <button
                      type="button"
                      onClick={() => openRun(run.uuid)}
                      className="text-xs underline text-theme-text-secondary hover:text-theme-text-primary"
                    >
                      Results
                    </button>
                  ),
                },
              ]}
              rows={runs}
            />
          </Card>

          {creating && (
            <CreateTest
              agents={agents}
              onClose={() => setCreating(false)}
              onCreated={() => {
                setCreating(false);
                load();
              }}
            />
          )}

          {viewing && (
            <Modal title="Run results" onClose={() => setViewing(null)} wide>
              <div className="space-y-3">
                {viewing.results.map((result) => (
                  <div
                    key={result.id}
                    className="rounded-lg border border-theme-modal-border p-3"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <p className="text-sm font-medium text-theme-text-primary">
                        {result.question}
                      </p>
                      <Badge tone={VERDICT_TONE[result.verdict] ?? "neutral"}>
                        {result.verdict.replace(/_/g, " ")}
                      </Badge>
                    </div>
                    <p className="mt-1 text-xs text-theme-text-secondary">
                      {result.detail}
                    </p>
                    {result.answer && (
                      <p className="mt-2 whitespace-pre-wrap rounded bg-theme-bg-primary p-2 text-xs text-theme-text-primary">
                        {result.answer}
                      </p>
                    )}
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

function CreateTest({ agents, onClose, onCreated }) {
  const [form, setForm] = useState({
    question: "",
    expectedConcepts: "",
    requiredSource: "",
    agentUuid: "",
  });
  const [saving, setSaving] = useState(false);

  async function submit() {
    if (!form.question.trim()) return showToast("Enter a question.", "error");
    setSaving(true);
    const result = await Business.quality.createTest(form);
    setSaving(false);
    if (result?.error) return showToast(result.error, "error");
    showToast("Test added.", "success");
    onCreated();
  }

  return (
    <Modal title="New quality test" onClose={onClose}>
      <label className="block text-sm">
        <span className="text-theme-text-secondary">Question to ask</span>
        <input
          value={form.question}
          onChange={(e) => setForm({ ...form, question: e.target.value })}
          placeholder="What is your refund policy?"
          className="mt-1 w-full rounded-lg border border-theme-modal-border bg-theme-bg-primary px-3 py-2 text-theme-text-primary"
        />
      </label>

      <label className="mt-4 block text-sm">
        <span className="text-theme-text-secondary">
          The answer must mention (comma separated)
        </span>
        <input
          value={form.expectedConcepts}
          onChange={(e) =>
            setForm({ ...form, expectedConcepts: e.target.value })
          }
          placeholder="30 days, receipt, original payment method"
          className="mt-1 w-full rounded-lg border border-theme-modal-border bg-theme-bg-primary px-3 py-2 text-theme-text-primary"
        />
      </label>

      <label className="mt-4 block text-sm">
        <span className="text-theme-text-secondary">
          Required source document (optional)
        </span>
        <input
          value={form.requiredSource}
          onChange={(e) => setForm({ ...form, requiredSource: e.target.value })}
          placeholder="Refund Policy.pdf"
          className="mt-1 w-full rounded-lg border border-theme-modal-border bg-theme-bg-primary px-3 py-2 text-theme-text-primary"
        />
      </label>

      <label className="mt-4 block text-sm">
        <span className="text-theme-text-secondary">
          Which agent should answer?
        </span>
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

      <div className="mt-6 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={submit} disabled={saving}>
          {saving ? "Saving…" : "Add test"}
        </Button>
      </div>
    </Modal>
  );
}

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

export default function TeamPage() {
  const [data, setData] = useState(null);
  const [keys, setKeys] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [inviting, setInviting] = useState(false);
  const [newKey, setNewKey] = useState(null);

  async function load() {
    setLoading(true);
    const [teamResult, keyResult] = await Promise.all([
      Business.team.all(),
      Business.apiKeys.all(),
    ]);
    if (teamResult?.error) setError(teamResult.error);
    else setData(teamResult);
    if (!keyResult?.error) setKeys(keyResult);
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
          title="Team"
          description="Who can use your AI platform, and what they can do."
          loading={loading}
          error={error}
          actions={
            <Button onClick={() => setInviting(true)}>Add person</Button>
          }
        >
          {data?.limits && (
            <p className="text-xs text-theme-text-secondary">
              {data.limits.used} of {data.limits.maxUsers} named users included
              in your plan.
            </p>
          )}

          <Card title="People">
            <Table
              columns={[
                {
                  key: "username",
                  label: "Person",
                  render: (member) => (
                    <div>
                      <p className="font-medium">{member.username}</p>
                      {member.title && (
                        <p className="text-xs text-theme-text-secondary">
                          {member.title}
                        </p>
                      )}
                    </div>
                  ),
                },
                {
                  key: "businessRole",
                  label: "Role",
                  render: (member) => (
                    <select
                      value={member.businessRole}
                      disabled={member.businessRole === "owner"}
                      onChange={async (e) => {
                        const result = await Business.team.setRole(member.id, {
                          role: e.target.value,
                        });
                        if (result?.error)
                          return showToast(result.error, "error");
                        showToast("Role updated.", "success");
                        load();
                      }}
                      className="rounded border border-theme-modal-border bg-theme-bg-primary px-2 py-1 text-xs capitalize text-theme-text-primary disabled:opacity-60"
                    >
                      {(data?.roles ?? []).map((role) => (
                        <option key={role.key} value={role.key}>
                          {role.key}
                        </option>
                      ))}
                    </select>
                  ),
                },
                {
                  key: "suspended",
                  label: "Status",
                  render: (member) => (
                    <Badge tone={member.suspended ? "danger" : "success"}>
                      {member.suspended ? "Suspended" : "Active"}
                    </Badge>
                  ),
                },
                {
                  key: "createdAt",
                  label: "Added",
                  render: (m) => new Date(m.createdAt).toLocaleDateString(),
                },
                {
                  key: "actions",
                  label: "",
                  render: (member) =>
                    member.businessRole === "owner" ? (
                      <span className="text-xs text-theme-text-secondary">
                        Owner
                      </span>
                    ) : (
                      <div className="flex gap-3">
                        <button
                          type="button"
                          onClick={async () => {
                            const result = await Business.team.suspend(
                              member.id,
                              !member.suspended
                            );
                            if (result?.error)
                              return showToast(result.error, "error");
                            load();
                          }}
                          className="text-xs underline text-theme-text-secondary hover:text-theme-text-primary"
                        >
                          {member.suspended ? "Reinstate" : "Suspend"}
                        </button>
                        <button
                          type="button"
                          onClick={async () => {
                            if (!window.confirm(`Remove ${member.username}?`))
                              return;
                            const result = await Business.team.remove(
                              member.id
                            );
                            if (result?.error)
                              return showToast(result.error, "error");
                            showToast("Removed.", "success");
                            load();
                          }}
                          className="text-xs underline text-red-400"
                        >
                          Remove
                        </button>
                      </div>
                    ),
                },
              ]}
              rows={data?.members ?? []}
            />
          </Card>

          <Card title="What each role can do">
            <ul className="space-y-2 text-sm">
              {(data?.roles ?? []).map((role) => (
                <li key={role.key} className="flex gap-3">
                  <span className="w-32 shrink-0 font-medium capitalize text-theme-text-primary">
                    {role.key}
                  </span>
                  <span className="text-theme-text-secondary">
                    {role.description}
                  </span>
                </li>
              ))}
            </ul>
          </Card>

          <Card
            title="API keys"
            actions={
              <Button
                variant="secondary"
                onClick={async () => {
                  const name = window.prompt(
                    "Name this key (e.g. 'Website backend'):"
                  );
                  if (name === null) return;
                  const result = await Business.apiKeys.create(name);
                  if (result?.error) return showToast(result.error, "error");
                  setNewKey(result);
                  load();
                }}
              >
                Create key
              </Button>
            }
          >
            <p className="mb-3 text-xs text-theme-text-secondary">
              {keys?.notice}
            </p>
            <Table
              empty="No API keys."
              columns={[
                {
                  key: "name",
                  label: "Name",
                  render: (k) => k.name ?? "Unnamed",
                },
                { key: "fingerprint", label: "Key" },
                {
                  key: "createdAt",
                  label: "Created",
                  render: (k) => new Date(k.createdAt).toLocaleDateString(),
                },
                {
                  key: "actions",
                  label: "",
                  render: (key) => (
                    <button
                      type="button"
                      onClick={async () => {
                        if (
                          !window.confirm(
                            "Revoke this key? Anything using it will stop working immediately."
                          )
                        )
                          return;
                        const result = await Business.apiKeys.revoke(key.id);
                        if (result?.error)
                          return showToast(result.error, "error");
                        showToast("Key revoked.", "success");
                        load();
                      }}
                      className="text-xs underline text-red-400"
                    >
                      Revoke
                    </button>
                  ),
                },
              ]}
              rows={keys?.apiKeys ?? []}
            />
          </Card>

          {inviting && (
            <AddPerson
              roles={data?.roles ?? []}
              onClose={() => setInviting(false)}
              onCreated={() => {
                setInviting(false);
                load();
              }}
            />
          )}

          {newKey && (
            <Modal
              title="Copy your API key now"
              onClose={() => setNewKey(null)}
            >
              <p className="text-sm text-amber-400">{newKey.warning}</p>
              <pre className="mt-3 overflow-x-auto rounded-lg border border-theme-modal-border bg-theme-bg-primary p-3 text-xs text-theme-text-primary">
                {newKey.apiKey.secret}
              </pre>
              <div className="mt-4 flex justify-end gap-2">
                <Button
                  onClick={() => {
                    navigator.clipboard?.writeText(newKey.apiKey.secret);
                    showToast("Copied.", "success");
                  }}
                >
                  Copy
                </Button>
                <Button variant="secondary" onClick={() => setNewKey(null)}>
                  Done
                </Button>
              </div>
            </Modal>
          )}
        </BusinessPage>
      </div>
    </div>
  );
}

function AddPerson({ roles, onClose, onCreated }) {
  const [form, setForm] = useState({
    username: "",
    password: "",
    role: "member",
    title: "",
  });
  const [saving, setSaving] = useState(false);

  async function submit() {
    if (!form.username.trim() || !form.password.trim())
      return showToast("A username and password are required.", "error");
    setSaving(true);
    const result = await Business.team.createUser(form);
    setSaving(false);
    if (result?.error) return showToast(result.error, "error");
    showToast("Person added.", "success");
    onCreated();
  }

  return (
    <Modal title="Add a person" onClose={onClose}>
      <div className="space-y-4">
        <label className="block text-sm">
          <span className="text-theme-text-secondary">Username</span>
          <input
            value={form.username}
            onChange={(e) => setForm({ ...form, username: e.target.value })}
            className="mt-1 w-full rounded-lg border border-theme-modal-border bg-theme-bg-primary px-3 py-2 text-theme-text-primary"
          />
        </label>
        <label className="block text-sm">
          <span className="text-theme-text-secondary">Temporary password</span>
          <input
            type="password"
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
            className="mt-1 w-full rounded-lg border border-theme-modal-border bg-theme-bg-primary px-3 py-2 text-theme-text-primary"
          />
        </label>
        <label className="block text-sm">
          <span className="text-theme-text-secondary">
            Job title (optional)
          </span>
          <input
            value={form.title}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
            className="mt-1 w-full rounded-lg border border-theme-modal-border bg-theme-bg-primary px-3 py-2 text-theme-text-primary"
          />
        </label>
        <label className="block text-sm">
          <span className="text-theme-text-secondary">Role</span>
          <select
            value={form.role}
            onChange={(e) => setForm({ ...form, role: e.target.value })}
            className="mt-1 w-full rounded-lg border border-theme-modal-border bg-theme-bg-primary px-3 py-2 capitalize text-theme-text-primary"
          >
            {roles
              .filter((role) => role.key !== "owner")
              .map((role) => (
                <option key={role.key} value={role.key}>
                  {role.key} — {role.description}
                </option>
              ))}
          </select>
        </label>
      </div>

      <div className="mt-6 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={submit} disabled={saving}>
          {saving ? "Adding…" : "Add person"}
        </Button>
      </div>
    </Modal>
  );
}

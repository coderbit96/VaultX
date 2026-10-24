"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { clearVaultKeyMaterial } from "@/lib/crypto/key-memory";
import { clearOfflineCopies } from "@/lib/offline/copies";

type SessionEntry = {
  id: string; deviceLabel: string; current: boolean;
  createdAt: string; lastSeenAt: string; idleExpiresAt: string; expiresAt: string;
};

function dateTime(value: string): string {
  return new Date(value).toLocaleString();
}

async function lockAndLeave(): Promise<void> {
  document.documentElement.dataset.vaultLocked = "true";
  clearVaultKeyMaterial();
  await clearOfflineCopies();
  window.location.replace("/unlock");
}

export function SessionSettings() {
  const [sessions, setSessions] = useState<SessionEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loginPassword, setLoginPassword] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    void fetch("/api/settings/sessions", { credentials: "same-origin", cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error();
        return response.json() as Promise<{ sessions: SessionEntry[] }>;
      })
      .then((data) => { if (active) setSessions(data.sessions); })
      .catch(() => { if (active) setError("Could not load sessions. Reload to try again."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  async function revoke(entry: SessionEntry) {
    if (!loginPassword || busyId) return;
    setBusyId(entry.id);
    setError("");
    try {
      if (entry.current) await clearOfflineCopies();
      const response = await fetch("/api/settings/sessions/revoke", {
        method: "POST", credentials: "same-origin", cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: entry.id, loginPassword }),
      });
      if (!response.ok) throw new Error(response.status === 401 ? "Check your current login password." : "Could not revoke this session. Try again.");
      setLoginPassword("");
      if (entry.current) { await lockAndLeave(); return; }
      setSessions((previous) => previous.filter((session) => session.id !== entry.id));
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not revoke this session."); }
    finally { setBusyId(null); }
  }

  return <section className="mt-8 rounded-3xl border border-line bg-surface p-6 sm:p-8" aria-labelledby="sessions-heading">
    <h2 id="sessions-heading" className="text-xl font-semibold">Signed-in devices</h2>
    <p className="mt-3 text-sm leading-6 text-muted">Active browser sessions only. The browser label is approximate; VaultX does not store an IP address or full browser fingerprint here. Revoking a session blocks its next private request.</p>
    {loading ? <p className="mt-5 text-sm text-muted" role="status">Loading sessions…</p> : null}
    {!loading && sessions.length === 0 ? <p className="mt-5 text-sm text-muted">No active sessions found.</p> : null}
    {sessions.length > 0 ? <>
      <label htmlFor="revoke-login-password" className="mt-5 block text-sm font-medium">Current login password to revoke a session</label>
      <Input id="revoke-login-password" className="mt-2" type="password" autoComplete="current-password" maxLength={1024}
        value={loginPassword} onChange={(event) => setLoginPassword(event.target.value)} />
      <ul className="mt-5 space-y-3">
        {sessions.map((entry) => <li key={entry.id} className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-line bg-raised p-4">
          <div className="min-w-0">
            <p className="font-medium">{entry.deviceLabel} {entry.current ? <span className="ml-2 text-xs text-accent">This session</span> : null}</p>
            <p className="mt-1 text-xs leading-5 text-muted">Started {dateTime(entry.createdAt)} · Last active {dateTime(entry.lastSeenAt)}</p>
          </div>
          <Button variant="danger" size="small" disabled={!loginPassword || busyId !== null} onClick={() => void revoke(entry)}
            aria-label={`Revoke ${entry.current ? "this session" : entry.deviceLabel + " session"}`}>
            {busyId === entry.id ? "Revoking…" : "Revoke"}
          </Button>
        </li>)}
      </ul>
    </> : null}
    {error ? <p className="mt-4 text-sm text-danger" role="alert">{error}</p> : null}
  </section>;
}

export function LoginPasswordSetting() {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (newPassword !== confirmation) { setError("New passwords do not match."); return; }
    setBusy(true); setError("");
    try {
      await clearOfflineCopies();
      const response = await fetch("/api/settings/password", {
        method: "POST", credentials: "same-origin", cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      if (!response.ok) throw new Error(response.status === 401 ? "Check your current login password."
        : response.status === 400 ? "Choose a different, stronger password of at least 16 characters."
          : "Could not change the password. Try again.");
      setCurrentPassword(""); setNewPassword(""); setConfirmation("");
      await lockAndLeave();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not change the password."); setBusy(false); }
  }

  return <section className="mt-8 rounded-3xl border border-line bg-surface p-6 sm:p-8" aria-labelledby="login-password-heading">
    <h2 id="login-password-heading" className="text-xl font-semibold">Change login password</h2>
    <p className="mt-3 text-sm leading-6 text-muted">This password signs you in. A change signs out every device. Your separate vault passphrase and encrypted files are unaffected.</p>
    <form onSubmit={save} className="mt-5 space-y-4">
      <label htmlFor="current-login-password" className="block text-sm font-medium">Current login password</label>
      <Input id="current-login-password" type="password" autoComplete="current-password" required maxLength={1024} disabled={busy}
        value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} />
      <label htmlFor="new-login-password" className="block text-sm font-medium">New login password</label>
      <Input id="new-login-password" type="password" autoComplete="new-password" required minLength={16} maxLength={1024} disabled={busy}
        value={newPassword} onChange={(event) => setNewPassword(event.target.value)} />
      <label htmlFor="confirm-login-password" className="block text-sm font-medium">Confirm new password</label>
      <Input id="confirm-login-password" type="password" autoComplete="new-password" required minLength={16} maxLength={1024} disabled={busy}
        value={confirmation} onChange={(event) => setConfirmation(event.target.value)} />
      {error ? <p role="alert" className="text-sm text-danger">{error}</p> : null}
      <Button type="submit" disabled={busy}>{busy ? "Changing…" : "Change login password"}</Button>
    </form>
  </section>;
}

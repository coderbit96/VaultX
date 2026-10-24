"use client";

import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { clearVaultKeyMaterial } from "@/lib/crypto/key-memory";

const choices = [1, 5, 15, 30, 60];

export function AutoLockSetting({ initialMinutes }: { initialMinutes: number }) {
  const [minutes, setMinutes] = useState(initialMinutes);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [loginPassword, setLoginPassword] = useState("");

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/settings", {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        credentials: "same-origin", cache: "no-store", body: JSON.stringify({ autoLockMinutes: minutes, loginPassword }),
      });
      if (!response.ok) throw new Error(response.status === 401 ? "Check your current login password." : "Could not save the timeout. Please try again.");
      document.documentElement.dataset.vaultLocked = "true";
      clearVaultKeyMaterial();
      window.location.replace("/unlock");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save the timeout. Please try again.");
      setBusy(false);
    }
  }

  return <form onSubmit={save} className="mt-6 space-y-4">
    <label htmlFor="auto-lock-minutes" className="block text-sm font-medium">Lock after inactivity</label>
    <select id="auto-lock-minutes" value={minutes} onChange={(event) => setMinutes(Number(event.target.value))}
      className="min-h-12 w-full rounded-xl border border-line bg-raised px-4 text-foreground focus-visible:outline-2 focus-visible:outline-accent">
      {!choices.includes(initialMinutes) ? <option value={initialMinutes}>{initialMinutes} minutes (current)</option> : null}
      {choices.map((value) => <option key={value} value={value}>{value} {value === 1 ? "minute" : "minutes"}</option>)}
    </select>
    <p className="text-sm leading-6 text-muted">VaultX locks when you switch apps or leave this tab. Saving a new timeout asks for your password again.</p>
    <label htmlFor="timeout-login-password" className="block text-sm font-medium">Current login password</label>
    <Input id="timeout-login-password" type="password" autoComplete="current-password" required maxLength={1024}
      value={loginPassword} onChange={(event) => setLoginPassword(event.target.value)} disabled={busy} />
    {error ? <p role="alert" className="text-sm text-danger">{error}</p> : null}
    <Button type="submit" disabled={busy || minutes === initialMinutes}>{busy ? "Saving…" : "Save timeout"}</Button>
  </form>;
}

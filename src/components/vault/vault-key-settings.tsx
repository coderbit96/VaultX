"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { derivePasswordInWorker } from "@/lib/crypto/argon2-worker-client";
import { clearVaultKeyMaterial, hasVaultRootKey, installVaultRootKey } from "@/lib/crypto/key-memory";
import { createVaultKeys, rotateVaultPassphrase, unlockVaultWithPassphrase, unlockVaultWithRecovery, VaultKeyError } from "@/lib/crypto/vault-keys";
import { vaultKeyEnvelopeSchema, type VaultKeyEnvelope } from "@/lib/crypto/vault-key-schema";
import { clearOfflineCopies } from "@/lib/offline/copies";

type Status = "loading" | "uninitialized" | "ready" | "migration_required" | "error";

async function ownerSessionActive(): Promise<boolean> {
  try {
    const response = await fetch("/api/auth/verify", {
      method: "POST", credentials: "same-origin", cache: "no-store",
    });
    return response.ok;
  } catch { return false; }
}

export function VaultKeySettings() {
  const [status, setStatus] = useState<Status>("loading");
  const [envelope, setEnvelope] = useState<VaultKeyEnvelope | null>(null);
  const [recoveryConfirmedAt, setRecoveryConfirmedAt] = useState<string | null>(null);
  const [pending, setPending] = useState<{ envelope: VaultKeyEnvelope; recoveryCode: string } | null>(null);
  const [passphrase, setPassphrase] = useState("");
  const [confirmPassphrase, setConfirmPassphrase] = useState("");
  const [separateConfirmed, setSeparateConfirmed] = useState(false);
  const [recoveryInput, setRecoveryInput] = useState("");
  const [savedOffline, setSavedOffline] = useState(false);
  const [method, setMethod] = useState<"password" | "recovery">("password");
  const [busy, setBusy] = useState(false);
  const [unlocked, setUnlocked] = useState(() => hasVaultRootKey());
  const [error, setError] = useState("");
  const [oldVaultPassphrase, setOldVaultPassphrase] = useState("");
  const [newVaultPassphrase, setNewVaultPassphrase] = useState("");
  const [newVaultConfirmation, setNewVaultConfirmation] = useState("");
  const [rotationLoginPassword, setRotationLoginPassword] = useState("");
  const [rotationError, setRotationError] = useState("");
  const epoch = useRef(0);
  const pendingRootKey = useRef<Uint8Array | null>(null);

  useEffect(() => {
    let active = true;
    const cleared = () => {
      epoch.current += 1;
      pendingRootKey.current?.fill(0);
      pendingRootKey.current = null;
      setPending(null);
      setPassphrase("");
      setConfirmPassphrase("");
      setRecoveryInput("");
      setSavedOffline(false);
      setSeparateConfirmed(false);
      setOldVaultPassphrase(""); setNewVaultPassphrase(""); setNewVaultConfirmation(""); setRotationLoginPassword("");
      setUnlocked(false);
    };
    window.addEventListener("vaultx:key-clear", cleared);
    void fetch("/api/vault/keys", { credentials: "same-origin", cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error();
        return response.json() as Promise<{ status: Status; envelope?: unknown; recoveryConfirmedAt?: string }>;
      })
      .then((data) => {
        if (!active) return;
        if (data.status === "ready") {
          const parsed = vaultKeyEnvelopeSchema.safeParse(data.envelope);
          if (!parsed.success) { setStatus("migration_required"); return; }
          setEnvelope(parsed.data);
          setRecoveryConfirmedAt(data.recoveryConfirmedAt ?? null);
          setStatus("ready");
        } else if (data.status === "uninitialized" || data.status === "migration_required") {
          setStatus(data.status);
        } else setStatus("error");
      })
      .catch(() => { if (active) setStatus("error"); });
    return () => {
      active = false;
      pendingRootKey.current?.fill(0);
      pendingRootKey.current = null;
      window.removeEventListener("vaultx:key-clear", cleared);
    };
  }, []);

  async function prepare(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    if (passphrase !== confirmPassphrase || passphrase.length < 16 || !separateConfirmed) {
      setError("Use a separate vault passphrase of at least 16 characters and confirm it exactly.");
      return;
    }
    const started = epoch.current;
    setBusy(true);
    try {
      const generated = await createVaultKeys(passphrase, derivePasswordInWorker);
      const active = await ownerSessionActive();
      if (started !== epoch.current || !active || document.documentElement.dataset.vaultLocked === "true") {
        generated.rootKey.fill(0);
        if (!active) { clearVaultKeyMaterial(); window.location.replace("/unlock"); }
        return;
      }
      // Do not expose an upload-ready key until its encrypted recovery backup
      // has been confirmed and committed to MongoDB.
      pendingRootKey.current?.fill(0);
      try { pendingRootKey.current = generated.rootKey.slice(); }
      finally { generated.rootKey.fill(0); }
      setPending({ envelope: generated.envelope, recoveryCode: generated.recoveryCode });
      setPassphrase("");
      setConfirmPassphrase("");
      setSavedOffline(false);
    } catch (caught) {
      if (started === epoch.current) setError(caught instanceof VaultKeyError && caught.code === "invalid_unlock"
        ? "Choose a longer, less predictable vault passphrase. No keys were saved."
        : "Could not prepare vault keys on this device. No keys were saved.");
    } finally { setBusy(false); }
  }

  async function confirmRecovery(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!pending || !savedOffline || recoveryInput.trim() !== pending.recoveryCode) {
      setError("Save the recovery key offline, then re-enter it exactly to confirm.");
      return;
    }
    if (!pendingRootKey.current) {
      setError("Key setup was interrupted. Reload and create a new recovery key.");
      return;
    }
    const started = epoch.current;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/vault/keys", {
        method: "POST", credentials: "same-origin", cache: "no-store",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify(pending.envelope),
      });
      if (started !== epoch.current) return;
      if (!response.ok) {
        if (response.status === 409) {
          clearVaultKeyMaterial();
          pendingRootKey.current?.fill(0);
          pendingRootKey.current = null;
          setPending(null);
          setStatus("error");
          setError("Key setup already exists or older data needs migration. Reload this page.");
        } else setError("Could not save the encrypted backup. Keep this page open and retry.");
        return;
      }
      const root = pendingRootKey.current;
      pendingRootKey.current = null;
      if (!root) throw new Error("Key setup was interrupted");
      try { installVaultRootKey(root, pending.envelope.vaultId); }
      finally { root.fill(0); }
      setEnvelope(pending.envelope);
      setPending(null);
      setRecoveryInput("");
      setSavedOffline(false);
      setStatus("ready");
      setUnlocked(hasVaultRootKey());
      setRecoveryConfirmedAt(new Date().toISOString());
    } catch { if (started === epoch.current) setError("Could not save the encrypted backup. Keep this page open and retry."); }
    finally { setBusy(false); }
  }

  async function unlock(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!envelope) return;
    const started = epoch.current;
    setBusy(true);
    setError("");
    try {
      const root = method === "password"
        ? await unlockVaultWithPassphrase(envelope, passphrase, derivePasswordInWorker)
        : await unlockVaultWithRecovery(envelope, recoveryInput);
      const active = await ownerSessionActive();
      if (started !== epoch.current || !active || document.documentElement.dataset.vaultLocked === "true") {
        root.fill(0);
        if (!active) { clearVaultKeyMaterial(); window.location.replace("/unlock"); }
        return;
      }
      try { installVaultRootKey(root, envelope.vaultId); }
      finally { root.fill(0); }
      setPassphrase("");
      setRecoveryInput("");
      setUnlocked(true);
    } catch { if (started === epoch.current) setError("Could not unlock the vault key. Check your passphrase or recovery key."); }
    finally { setBusy(false); }
  }

  async function rotate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!envelope || !unlocked) return;
    if (newVaultPassphrase !== newVaultConfirmation) { setRotationError("New vault passphrases do not match."); return; }
    const started = epoch.current;
    setBusy(true); setRotationError("");
    try {
      const replacement = await rotateVaultPassphrase(envelope, oldVaultPassphrase, newVaultPassphrase, derivePasswordInWorker);
      const active = await ownerSessionActive();
      if (started !== epoch.current || !active || document.documentElement.dataset.vaultLocked === "true") {
        if (!active) { clearVaultKeyMaterial(); window.location.replace("/unlock"); }
        return;
      }
      // The cached envelope must never keep the old vault passphrase valid.
      await clearOfflineCopies();
      const response = await fetch("/api/vault/keys", {
        method: "PUT", credentials: "same-origin", cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ loginPassword: rotationLoginPassword, previousRevision: envelope.revision, envelope: replacement }),
      });
      if (started !== epoch.current) return;
      if (!response.ok) throw new Error(response.status === 401 ? "Check your current login password."
        : response.status === 409 ? "Vault keys changed in another session. Reload and try again."
          : "Could not confirm the key change. Sign in again and check which passphrase works before retrying.");
      setOldVaultPassphrase(""); setNewVaultPassphrase(""); setNewVaultConfirmation(""); setRotationLoginPassword("");
      document.documentElement.dataset.vaultLocked = "true";
      clearVaultKeyMaterial();
      window.location.replace("/unlock");
    } catch (caught) {
      if (started === epoch.current) setRotationError(caught instanceof VaultKeyError
        ? "Check the current vault passphrase and choose a stronger new one."
        : caught instanceof Error ? caught.message : "Could not change the vault passphrase.");
      setBusy(false);
    }
  }

  return <section className="mt-8 rounded-3xl border border-line bg-surface p-6 sm:p-8" aria-labelledby="keys-heading">
    <h2 id="keys-heading" className="text-xl font-semibold">Vault encryption keys</h2>
    <p className="mt-3 text-sm leading-6 text-muted">Your owner login password signs you in. A separate vault passphrase protects the encryption key on this device.</p>

    {status === "loading" ? <p className="mt-5 text-sm text-muted" role="status">Checking key setup…</p> : null}
    {status === "error" ? <p className="mt-5 text-sm text-danger" role="alert">Key status is unavailable. Reload this page.</p> : null}
    {status === "migration_required" ? <p className="mt-5 text-sm text-danger" role="alert">This vault has older or incomplete key metadata. Setup is blocked until a reviewed migration is available.</p> : null}

    {status === "uninitialized" && !pending ? <form onSubmit={prepare} className="mt-6 space-y-4">
      <label htmlFor="vault-passphrase" className="block text-sm font-medium">Create a vault passphrase</label>
      <Input id="vault-passphrase" type="password" autoComplete="new-password" minLength={16} maxLength={1024} required disabled={busy}
        value={passphrase} onChange={(event) => setPassphrase(event.target.value)} />
      <label htmlFor="vault-passphrase-confirm" className="block text-sm font-medium">Confirm vault passphrase</label>
      <Input id="vault-passphrase-confirm" type="password" autoComplete="new-password" minLength={16} maxLength={1024} required disabled={busy}
        value={confirmPassphrase} onChange={(event) => setConfirmPassphrase(event.target.value)} />
      <label className="flex items-start gap-3 text-sm leading-6"><input type="checkbox" className="mt-1.5 size-4 accent-accent" checked={separateConfirmed}
        onChange={(event) => setSeparateConfirmed(event.target.checked)} disabled={busy} />This is different from my owner login password.</label>
      <p className="text-xs leading-5 text-muted">Use a long, unique passphrase. It stays in this browser and is processed with Argon2id. Losing both this passphrase and your recovery key can permanently lose access to future encrypted files.</p>
      <Button type="submit" disabled={busy}>{busy ? "Preparing keys…" : "Create vault keys"}</Button>
    </form> : null}

    {pending ? <form onSubmit={confirmRecovery} className="mt-6 space-y-4">
      <p className="text-sm leading-6">Write this recovery key on paper or save it in a trusted offline password manager. It appears only during this setup and cannot be retrieved later. Finish confirmation before leaving this page.</p>
      <div className="break-all rounded-xl border border-accent/40 bg-raised p-4 font-mono text-sm" aria-label="One-time recovery key">{pending.recoveryCode}</div>
      <label htmlFor="recovery-confirm" className="block text-sm font-medium">Re-enter the entire recovery key</label>
      <Input id="recovery-confirm" type="password" autoComplete="off" required disabled={busy} value={recoveryInput}
        onChange={(event) => setRecoveryInput(event.target.value)} />
      <label className="flex items-start gap-3 text-sm leading-6"><input type="checkbox" className="mt-1.5 size-4 accent-accent" checked={savedOffline}
        onChange={(event) => setSavedOffline(event.target.checked)} disabled={busy} />I saved this recovery key offline and can find it later.</label>
      <Button type="submit" disabled={busy || !savedOffline}>{busy ? "Saving encrypted backup…" : "Confirm and save encrypted backup"}</Button>
    </form> : null}

    {status === "ready" ? <div className="mt-6">
      <p className="text-sm text-muted">{recoveryConfirmedAt ? `You confirmed an offline recovery-key backup on ${new Date(recoveryConfirmedAt).toLocaleDateString()}.` : "Recovery-key backup status is unavailable."} VaultX cannot check whether the offline copy still exists. The recovery key will not be shown again.</p>
      {unlocked ? <p className="mt-4 text-sm text-accent" role="status">Vault key unlocked on this device. Locking clears app-held key memory where practical.</p>
        : <form onSubmit={unlock} className="mt-5 space-y-4">
          <div className="flex flex-wrap gap-2" role="group" aria-label="Vault key unlock method">
            <Button variant={method === "password" ? "primary" : "secondary"} onClick={() => { setMethod("password"); setError(""); }}>Vault passphrase</Button>
            <Button variant={method === "recovery" ? "primary" : "secondary"} onClick={() => { setMethod("recovery"); setError(""); }}>Recovery key</Button>
          </div>
          <label htmlFor="key-unlock" className="block text-sm font-medium">{method === "password" ? "Vault passphrase" : "Recovery key"}</label>
          <Input id="key-unlock" type="password" autoComplete="off" required disabled={busy}
            value={method === "password" ? passphrase : recoveryInput}
            onChange={(event) => method === "password" ? setPassphrase(event.target.value) : setRecoveryInput(event.target.value)} />
          <Button type="submit" disabled={busy}>{busy ? "Unlocking key…" : "Unlock encryption key"}</Button>
        </form>}
      {unlocked ? <form onSubmit={rotate} className="mt-8 space-y-4 border-t border-line pt-6">
        <h3 className="text-lg font-semibold">Change vault passphrase</h3>
        <p className="text-sm leading-6 text-muted">Rewraps the vault master key in this browser. Existing encrypted files and your offline recovery key stay valid. Every device signs out afterward.</p>
        <label htmlFor="old-vault-passphrase" className="block text-sm font-medium">Current vault passphrase</label>
        <Input id="old-vault-passphrase" type="password" autoComplete="off" required maxLength={1024} disabled={busy}
          value={oldVaultPassphrase} onChange={(event) => setOldVaultPassphrase(event.target.value)} />
        <label htmlFor="new-vault-passphrase" className="block text-sm font-medium">New vault passphrase</label>
        <Input id="new-vault-passphrase" type="password" autoComplete="new-password" required minLength={16} maxLength={1024} disabled={busy}
          value={newVaultPassphrase} onChange={(event) => setNewVaultPassphrase(event.target.value)} />
        <label htmlFor="confirm-new-vault-passphrase" className="block text-sm font-medium">Confirm new vault passphrase</label>
        <Input id="confirm-new-vault-passphrase" type="password" autoComplete="new-password" required minLength={16} maxLength={1024} disabled={busy}
          value={newVaultConfirmation} onChange={(event) => setNewVaultConfirmation(event.target.value)} />
        <label htmlFor="rotation-login-password" className="block text-sm font-medium">Current login password to confirm</label>
        <Input id="rotation-login-password" type="password" autoComplete="current-password" required maxLength={1024} disabled={busy}
          value={rotationLoginPassword} onChange={(event) => setRotationLoginPassword(event.target.value)} />
        {rotationError ? <p className="text-sm text-danger" role="alert">{rotationError}</p> : null}
        <Button type="submit" disabled={busy}>{busy ? "Rewrapping…" : "Change vault passphrase"}</Button>
      </form> : null}
    </div> : null}
    {error ? <p className="mt-4 text-sm text-danger" role="alert">{error}</p> : null}
  </section>;
}

"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type PasskeyEntry = { id: string; createdAt: string; lastUsedAt: string | null; rpId: string | null };
type PinStatus = { enabled: boolean; expiresAt: string | null; lockedUntil: string | null };

export function DeviceSecuritySettings() {
  const [pinStatus, setPinStatus] = useState<PinStatus | null>(null);
  const [passkeys, setPasskeys] = useState<PasskeyEntry[]>([]);
  const [supported, setSupported] = useState(false);
  const [loginPassword, setLoginPassword] = useState("");
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  async function refresh() {
    const [pinResponse, passkeyResponse] = await Promise.all([
      fetch("/api/settings/pin", { credentials: "same-origin", cache: "no-store" }),
      fetch("/api/settings/passkeys", { credentials: "same-origin", cache: "no-store" }),
    ]);
    if (!pinResponse.ok || !passkeyResponse.ok) throw new Error();
    setPinStatus(await pinResponse.json() as PinStatus);
    setPasskeys((await passkeyResponse.json() as { passkeys: PasskeyEntry[] }).passkeys);
  }

  useEffect(() => {
    queueMicrotask(() => { void refresh().catch(() => setError("Could not load device settings. Reload to try again.")); });
    if (typeof PublicKeyCredential !== "undefined" && window.isSecureContext) {
      void PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable().then(setSupported).catch(() => setSupported(false));
    }
  }, []);

  async function savePin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(""); setMessage(""); setBusy(true);
    try {
      const response = await fetch("/api/settings/pin", {
        method: "POST", credentials: "same-origin", cache: "no-store",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ loginPassword, pin }),
      });
      if (!response.ok) throw new Error(response.status === 401 ? "Check your current login password." : "Could not save this PIN.");
      setPin(""); setLoginPassword(""); setMessage("PIN saved for this browser profile. Your vault passphrase is still needed after sign-in.");
      await refresh();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not save this PIN."); }
    finally { setBusy(false); }
  }

  async function disablePin() {
    setError(""); setMessage(""); setBusy(true);
    try {
      const response = await fetch("/api/settings/pin", {
        method: "DELETE", credentials: "same-origin", cache: "no-store",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ loginPassword }),
      });
      if (!response.ok) throw new Error(response.status === 401 ? "Check your current login password." : "Could not disable this PIN.");
      setPin(""); setLoginPassword(""); setMessage("PIN disabled for this browser profile.");
      await refresh();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not disable this PIN."); }
    finally { setBusy(false); }
  }

  async function registerPasskey() {
    if (!supported || !loginPassword) return;
    setError(""); setMessage(""); setBusy(true);
    try {
      const optionsResponse = await fetch("/api/settings/passkeys/options", {
        method: "POST", credentials: "same-origin", cache: "no-store",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ loginPassword }),
      });
      if (!optionsResponse.ok) throw new Error(optionsResponse.status === 401 ? "Check your current login password." : "Could not start passkey setup.");
      const { options } = await optionsResponse.json();
      const { startRegistration } = await import("@simplewebauthn/browser");
      const credential = await startRegistration({ optionsJSON: options });
      const verifyResponse = await fetch("/api/settings/passkeys/verify", {
        method: "POST", credentials: "same-origin", cache: "no-store",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ credential }),
      });
      if (!verifyResponse.ok) throw new Error("The passkey was not verified. Try again.");
      setLoginPassword(""); setMessage("Passkey added. Your vault passphrase or recovery key is still needed to decrypt files.");
      await refresh();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not add a passkey."); }
    finally { setBusy(false); }
  }

  async function removePasskey(id: string) {
    setError(""); setMessage(""); setBusy(true);
    try {
      const response = await fetch("/api/settings/passkeys", {
        method: "DELETE", credentials: "same-origin", cache: "no-store",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, loginPassword }),
      });
      if (!response.ok) throw new Error(response.status === 401 ? "Check your current login password." : "Could not remove this passkey.");
      setLoginPassword(""); setMessage("Passkey removed from VaultX. You may also remove it in your device settings.");
      await refresh();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not remove this passkey."); }
    finally { setBusy(false); }
  }

  return <section className="mt-8 rounded-3xl border border-line bg-surface p-6 sm:p-8" aria-labelledby="device-security-heading">
    <h2 id="device-security-heading" className="text-xl font-semibold">Optional device sign-in</h2>
    <p className="mt-3 text-sm leading-6 text-muted">A PIN or platform passkey can sign in after you set it up using your login password. Neither restores a cleared vault encryption key. Enter your separate vault passphrase or recovery key in Settings before opening encrypted files. Login password sign-in always remains available.</p>
    <label htmlFor="device-login-password" className="mt-5 block text-sm font-medium">Current login password to change device methods</label>
    <Input id="device-login-password" className="mt-2" type="password" autoComplete="current-password" maxLength={1024}
      value={loginPassword} onChange={(event) => setLoginPassword(event.target.value)} disabled={busy} />
    <form onSubmit={savePin} className="mt-6 space-y-3 border-t border-line pt-6">
      <h3 className="font-semibold">Six-digit PIN for this browser</h3>
      <p className="text-xs leading-5 text-muted">Valid for up to 30 days in this browser profile. Five wrong attempts lock PIN sign-in for 30 minutes. Clearing cookies disables it here. A copied browser cookie can copy this convenience credential, so keep your device protected.</p>
      <label htmlFor="device-pin" className="block text-sm font-medium">{pinStatus?.enabled ? "New PIN (reset)" : "Create PIN"}</label>
      <Input id="device-pin" type="password" inputMode="numeric" autoComplete="off" pattern="[0-9]{6}" minLength={6} maxLength={6}
        required value={pin} onChange={(event) => setPin(event.target.value.replace(/\D/g, "").slice(0, 6))} disabled={busy} />
      <div className="flex flex-wrap gap-3">
        <Button type="submit" disabled={busy || !loginPassword}>{pinStatus?.enabled ? "Reset PIN" : "Enable PIN"}</Button>
        {pinStatus?.enabled ? <Button variant="danger" onClick={() => void disablePin()} disabled={busy || !loginPassword}>Disable PIN</Button> : null}
      </div>
      {pinStatus?.enabled ? <p className="text-xs text-muted">PIN active until {new Date(pinStatus.expiresAt!).toLocaleDateString()}.</p> : null}
    </form>
    <div className="mt-7 space-y-4 border-t border-line pt-6">
      <h3 className="font-semibold">Platform passkeys</h3>
      <p className="text-xs leading-5 text-muted">Your device may ask for fingerprint, face, or device PIN verification. VaultX never receives biometric data. Passkeys require a supported secure browser and may sync through your device account.</p>
      <Button variant="secondary" onClick={() => void registerPasskey()} disabled={busy || !supported || !loginPassword}>Add platform passkey</Button>
      {!supported ? <p className="text-xs text-muted">No supported platform authenticator was detected here. Use your login password.</p> : null}
      {passkeys.length ? <ul className="space-y-2">{passkeys.map((entry) => <li key={entry.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-raised p-3 text-sm">
        <span>Added {new Date(entry.createdAt).toLocaleDateString()}{entry.lastUsedAt ? ` · Used ${new Date(entry.lastUsedAt).toLocaleDateString()}` : ""}</span>
        <Button variant="danger" size="small" onClick={() => void removePasskey(entry.id)} disabled={busy || !loginPassword}>Remove</Button>
      </li>)}</ul> : <p className="text-sm text-muted">No passkeys enrolled.</p>}
    </div>
    {error ? <p className="mt-4 text-sm text-danger" role="alert">{error}</p> : null}
    {message ? <p className="mt-4 text-sm text-accent" role="status">{message}</p> : null}
  </section>;
}

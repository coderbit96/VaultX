"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { signIn } from "next-auth/react";
import { Eye, EyeOff, LockKeyhole } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function LoginForm() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [email, setEmail] = useState("");
  const [pin, setPin] = useState("");
  const [pinAvailable, setPinAvailable] = useState(false);
  const [passkeyAvailable, setPasskeyAvailable] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void fetch("/api/auth/pin/status", { credentials: "same-origin", cache: "no-store" })
      .then(async (response) => response.ok ? response.json() as Promise<{ enabled: boolean }> : { enabled: false })
      .then((status) => setPinAvailable(status.enabled)).catch(() => undefined);
    if (typeof PublicKeyCredential !== "undefined" && window.isSecureContext) {
      void PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()
        .then(setPasskeyAvailable).catch(() => setPasskeyAvailable(false));
    }
  }, []);

  async function finishSignIn(destination: string) {
    try {
      const result = await signIn("vaultx-session", { email: email.trim(), redirect: false });
      if (!result?.ok || result.error) throw new Error("Invalid credentials.");
      router.replace(destination);
    } catch (error) {
      await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin", cache: "no-store" }).catch(() => undefined);
      throw error;
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(""); setBusy(true); setShowPassword(false);
    try {
      const response = await fetch("/api/auth/login", { method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }), cache: "no-store" });
      setPassword("");
      if (!response.ok) { setError(response.status === 429 ? "Too many attempts. Wait 15 minutes and try again." :
        response.status === 503 ? "Sign-in is temporarily unavailable. Try again shortly." : "Invalid credentials."); return; }
      await finishSignIn("/vault");
    } catch (caught) { setPassword(""); setError(caught instanceof Error ? caught.message : "Sign-in is temporarily unavailable. Try again shortly."); }
    finally { setBusy(false); }
  }

  async function signInWithPin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError("");
    if (!email.trim()) { setError("Enter your owner email first."); return; }
    setBusy(true);
    try {
      const response = await fetch("/api/auth/pin", { method: "POST", credentials: "same-origin", cache: "no-store",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pin }) });
      setPin("");
      if (!response.ok) { setError(response.status === 429 ? "PIN locked. Wait 30 minutes or use your login password." : "Invalid PIN. You can always use your login password."); return; }
      await finishSignIn("/vault/settings");
    } catch (caught) { setPin(""); setError(caught instanceof Error ? caught.message : "PIN sign-in is unavailable. Use your login password."); }
    finally { setBusy(false); }
  }

  async function signInWithPasskey() {
    setError("");
    if (!email.trim()) { setError("Enter your owner email first."); return; }
    setBusy(true);
    try {
      const optionsResponse = await fetch("/api/auth/passkey/options", { method: "POST", credentials: "same-origin", cache: "no-store" });
      if (!optionsResponse.ok) throw new Error("Passkey sign-in is unavailable. Use your login password.");
      const { options } = await optionsResponse.json();
      const { startAuthentication } = await import("@simplewebauthn/browser");
      const credential = await startAuthentication({ optionsJSON: options });
      const verifyResponse = await fetch("/api/auth/passkey/verify", { method: "POST", credentials: "same-origin", cache: "no-store",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ credential }) });
      if (!verifyResponse.ok) throw new Error("Passkey verification failed. Use your login password or try again.");
      await finishSignIn("/vault/settings");
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Passkey sign-in failed. Use your login password."); }
    finally { setBusy(false); }
  }

  return <div className="mt-8 space-y-5">
    <form onSubmit={submit} className="space-y-4">
      <label htmlFor="owner-email" className="block text-sm font-medium text-foreground">Owner email</label>
      <Input id="owner-email" type="email" name="email" autoComplete="username" required maxLength={254}
        value={email} onChange={(event) => setEmail(event.target.value)} disabled={busy} aria-describedby="login-error" />
      <label htmlFor="owner-password" className="block text-sm font-medium text-foreground">Owner password</label>
      <div className="relative">
        <Input id="owner-password" type={showPassword ? "text" : "password"} name="password" autoComplete="current-password"
          required maxLength={1024} className="pr-14" value={password} onChange={(event) => setPassword(event.target.value)}
          disabled={busy} aria-describedby="login-help login-error" />
        <button type="button" aria-label={showPassword ? "Hide password" : "Show password"} aria-pressed={showPassword}
          onClick={() => setShowPassword((current) => !current)} disabled={busy}
          className="absolute right-1 top-1/2 flex size-11 -translate-y-1/2 items-center justify-center rounded-lg text-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50">
          {showPassword ? <EyeOff aria-hidden="true" size={19} /> : <Eye aria-hidden="true" size={19} />}
        </button>
      </div>
      <p id="login-help" className="text-xs leading-5 text-muted">Use the private password you created with the terminal bootstrap command.</p>
      <Button type="submit" disabled={busy} className="w-full"><LockKeyhole aria-hidden="true" size={17} />{busy ? "Checking…" : "Unlock VaultX"}</Button>
    </form>
    {pinAvailable ? <form onSubmit={signInWithPin} className="space-y-3 border-t border-line pt-5">
      <p className="text-xs text-muted">Enter your owner email above before using this device option.</p>
      <label htmlFor="device-signin-pin" className="block text-sm font-medium">Six-digit PIN for this browser</label>
      <Input id="device-signin-pin" type="password" inputMode="numeric" autoComplete="off" pattern="[0-9]{6}" minLength={6} maxLength={6}
        required value={pin} onChange={(event) => setPin(event.target.value.replace(/\D/g, "").slice(0, 6))} disabled={busy} />
      <Button variant="secondary" type="submit" disabled={busy} className="w-full">Sign in with PIN</Button>
    </form> : null}
    {passkeyAvailable ? <div className="border-t border-line pt-5"><Button variant="secondary" onClick={() => void signInWithPasskey()} disabled={busy} className="w-full">Sign in with passkey</Button></div> : null}
    {error ? <p id="login-error" role="alert" className="text-sm text-danger">{error}</p> : <span id="login-error" className="sr-only" />}
    <p className="text-xs leading-5 text-muted">Your files have a separate password. You will enter it after sign-in, or use your saved recovery key.</p>
  </div>;
}

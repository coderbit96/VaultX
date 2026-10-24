"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { LockKeyhole } from "lucide-react";
import { Button } from "@/components/ui/button";
import { clearVaultKeyMaterial } from "@/lib/crypto/key-memory";

export function LockManager({ autoLockMinutes }: { autoLockMinutes: number }) {
  const [locked, setLocked] = useState(false);
  const lockedRef = useRef(false);
  const lastActivity = useRef(0);
  const channel = useRef<BroadcastChannel | null>(null);

  const lock = useCallback((navigate: boolean, broadcast = true) => {
    if (lockedRef.current) {
      if (navigate && document.visibilityState === "visible") window.location.replace("/unlock");
      return;
    }
    lockedRef.current = true;
    document.documentElement.dataset.vaultLocked = "true";
    clearVaultKeyMaterial();
    setLocked(true);
    if (broadcast) channel.current?.postMessage("lock");
    // If the network stalls, the unlock page will make another server-side lock attempt.
    if (navigate) window.setTimeout(() => {
      if (document.visibilityState === "visible") window.location.replace("/unlock");
    }, 1500);
    void fetch("/api/auth/lock", { method: "POST", credentials: "same-origin", cache: "no-store", keepalive: true })
      .catch(() => undefined)
      .finally(() => {
        if (navigate && document.visibilityState === "visible") window.location.replace("/unlock");
      });
  }, []);

  useEffect(() => {
    lastActivity.current = Date.now();
    const timeout = autoLockMinutes * 60_000;
    let idleTimer: number;
    const scheduleIdle = () => {
      window.clearTimeout(idleTimer);
      idleTimer = window.setTimeout(() => lock(true), timeout);
    };
    const activity = () => {
      if (!lockedRef.current && document.visibilityState === "visible") {
        lastActivity.current = Date.now();
        scheduleIdle();
      }
    };
    const visibility = () => {
      if (document.visibilityState === "hidden") lock(false);
      else if (lockedRef.current) window.location.replace("/unlock");
    };
    const pageHide = () => lock(false);
    const pageShow = (event: PageTransitionEvent) => { if (event.persisted) lock(true); };
    const heartbeat = async () => {
      if (lockedRef.current || document.visibilityState !== "visible") return;
      if (Date.now() - lastActivity.current >= timeout) { lock(true); return; }
      try {
        const response = await fetch("/api/auth/verify", { method: "POST", credentials: "same-origin", cache: "no-store" });
        if (!response.ok) lock(true);
      } catch { lock(true); }
    };
    const interval = window.setInterval(heartbeat, Math.min(30_000, Math.max(5_000, Math.floor(timeout / 3))));
    scheduleIdle();
    const events = ["pointerdown", "keydown", "touchstart", "scroll"] as const;
    for (const event of events) window.addEventListener(event, activity, { passive: true });
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("pagehide", pageHide);
    window.addEventListener("pageshow", pageShow);
    if (typeof BroadcastChannel !== "undefined") {
      channel.current = new BroadcastChannel("vaultx-lock");
      channel.current.onmessage = () => lock(true, false);
    }
    if (document.visibilityState === "hidden") lock(false);
    return () => {
      window.clearInterval(interval);
      window.clearTimeout(idleTimer);
      for (const event of events) window.removeEventListener(event, activity);
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("pagehide", pageHide);
      window.removeEventListener("pageshow", pageShow);
      channel.current?.close();
      channel.current = null;
    };
  }, [autoLockMinutes, lock]);

  return <>
    {locked ? createPortal(<div role="status" className="fixed inset-0 z-[100] flex items-center justify-center bg-canvas text-foreground">Vault locked. Opening unlock screen…</div>, document.body) : null}
    <Button variant="ghost" size="small" onClick={() => lock(true)} aria-label="Lock vault now">
      <LockKeyhole aria-hidden="true" size={17} /><span className="hidden sm:inline">Lock</span>
    </Button>
  </>;
}

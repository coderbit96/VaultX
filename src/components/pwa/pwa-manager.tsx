"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Download, RotateCw, Wifi, WifiOff } from "lucide-react";
import { clearVaultKeyMaterial } from "@/lib/crypto/key-memory";

type InstallPrompt = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: "accepted" | "dismissed" }> };

function lockForUpdate() {
  document.documentElement.dataset.vaultLocked = "true";
  clearVaultKeyMaterial();
  void fetch("/api/auth/lock", { method: "POST", credentials: "same-origin", cache: "no-store", keepalive: true })
    .catch(() => undefined);
}

export function PwaManager() {
  const pathname = usePathname();
  const [online, setOnline] = useState(true);
  const [installPrompt, setInstallPrompt] = useState<InstallPrompt | null>(null);
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null);
  const [updating, setUpdating] = useState(false);
  const registration = useRef<ServiceWorkerRegistration | null>(null);
  const switching = useRef(false);
  const controlled = useRef(false);

  useEffect(() => {
    const syncOnline = () => setOnline(navigator.onLine);
    const offerInstall = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as InstallPrompt);
    };
    const installed = () => setInstallPrompt(null);
    window.addEventListener("online", syncOnline);
    window.addEventListener("offline", syncOnline);
    window.addEventListener("beforeinstallprompt", offerInstall);
    window.addEventListener("appinstalled", installed);
    queueMicrotask(syncOnline);

    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) {
      return () => {
        window.removeEventListener("online", syncOnline);
        window.removeEventListener("offline", syncOnline);
        window.removeEventListener("beforeinstallprompt", offerInstall);
        window.removeEventListener("appinstalled", installed);
      };
    }
    let active = true;
    let timer: number | undefined;
    controlled.current = !!navigator.serviceWorker.controller;
    const controllerChanged = () => {
      if (!controlled.current) { controlled.current = true; return; }
      if (!switching.current) { switching.current = true; lockForUpdate(); }
      window.location.replace("/unlock");
    };
    const checkWaiting = () => {
      if (active && registration.current?.waiting && navigator.serviceWorker.controller) {
        setWaiting(registration.current.waiting);
      }
    };
    const watchUpdate = (worker: ServiceWorker) => {
      worker.addEventListener("statechange", checkWaiting);
    };
    const update = () => { if (navigator.onLine) void registration.current?.update().catch(() => undefined); };
    navigator.serviceWorker.addEventListener("controllerchange", controllerChanged);
    void navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" })
      .then((found) => {
        if (!active) return;
        registration.current = found;
        checkWaiting();
        if (found.installing) watchUpdate(found.installing);
        found.addEventListener("updatefound", () => { if (found.installing) watchUpdate(found.installing); });
        update();
        timer = window.setInterval(update, 60 * 60_000);
      }).catch(() => undefined);
    window.addEventListener("online", update);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener("online", syncOnline);
      window.removeEventListener("offline", syncOnline);
      window.removeEventListener("online", update);
      window.removeEventListener("beforeinstallprompt", offerInstall);
      window.removeEventListener("appinstalled", installed);
      navigator.serviceWorker.removeEventListener("controllerchange", controllerChanged);
    };
  }, []);

  async function install() {
    if (!installPrompt) return;
    const prompt = installPrompt;
    setInstallPrompt(null);
    try { await prompt.prompt(); await prompt.userChoice; } catch { /* Browser install UI may be dismissed. */ }
  }

  async function activateUpdate() {
    if (!waiting || updating) return;
    setUpdating(true);
    switching.current = true;
    lockForUpdate();
    waiting.postMessage("SKIP_WAITING");
    window.setTimeout(() => window.location.replace("/unlock"), 2_000);
  }

  if (pathname.startsWith("/vault") && !waiting) return null;
  return <div className="pwa-status flex w-full flex-wrap items-center justify-end gap-2 border-b border-line bg-surface px-3 text-xs text-muted" aria-live="polite">
    <span className="flex min-h-8 items-center gap-1.5" role="status">{online ? <Wifi size={16} aria-hidden="true" className="text-accent" />
      : <WifiOff size={16} aria-hidden="true" className="text-danger" />}{online ? "Online" : "Offline · selected copies only"}</span>
    {installPrompt && <button type="button" onClick={() => void install()} className="flex min-h-11 items-center gap-1 rounded-lg px-2 text-accent hover:bg-raised focus-visible:outline-2 focus-visible:outline-accent"><Download size={16} aria-hidden="true" />Install</button>}
    {waiting && <button type="button" onClick={() => void activateUpdate()} disabled={updating} className="flex min-h-11 items-center gap-1 rounded-lg px-2 text-accent hover:bg-raised focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-60"><RotateCw size={16} aria-hidden="true" />{updating ? "Updating…" : "Update and lock"}</button>}
    <Link href="/install" className="flex min-h-11 items-center rounded-lg px-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-accent">Install help</Link>
  </div>;
}

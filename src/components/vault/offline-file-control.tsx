"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { hasVaultRootKey } from "@/lib/crypto/key-memory";
import { vaultKeyEnvelopeSchema } from "@/lib/crypto/vault-key-schema";
import { listOfflineCopies, removeOfflineCopy, saveOfflineCopy } from "@/lib/offline/copies";
import type { FileAccessMetadata } from "@/lib/files/types";
import { onFileDeleting } from "@/lib/files/deletion-events";

export function OfflineFileControl({ file }: { file: FileAccessMetadata }) {
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    let active = true;
    void listOfflineCopies().then((copies) => { if (active) setSaved(copies.some((copy) => copy.id === file.id)); }).catch(() => undefined);
    const clear = () => { controller.current?.abort(); setBusy(false); };
    window.addEventListener("vaultx:key-clear", clear);
    window.addEventListener("vaultx:offline-clear", clear);
    const channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel("vaultx-offline-clear");
    if (channel) channel.onmessage = clear;
    const stopDeletion = onFileDeleting((id) => { if (id === file.id || id === "*") clear(); });
    return () => { active = false; controller.current?.abort(); channel?.close(); stopDeletion(); window.removeEventListener("vaultx:key-clear", clear); window.removeEventListener("vaultx:offline-clear", clear); };
  }, [file.id]);
  async function save() {
    if (!hasVaultRootKey() || busy) return;
    setBusy(true); setError(""); setProgress(0);
    const signal = new AbortController(); controller.current = signal;
    try {
      const response = await fetch("/api/vault/keys", { credentials: "same-origin", cache: "no-store", signal: signal.signal });
      if (!response.ok) throw new Error("Vault key backup is unavailable. Reconnect and try again.");
      const data = await response.json() as { envelope?: unknown };
      const envelope = vaultKeyEnvelopeSchema.parse(data.envelope);
      await navigator.storage?.persist?.().catch(() => false);
      await saveOfflineCopy(file, envelope, (done, total) => setProgress(Math.floor(done / total * 100)), signal.signal);
      if (!signal.signal.aborted) setSaved(true);
    } catch (reason) {
      if (!signal.signal.aborted) setError(reason instanceof Error ? reason.message : "Could not save the encrypted copy.");
    } finally { setBusy(false); controller.current = null; }
  }
  async function remove() {
    setBusy(true); setError("");
    try { await removeOfflineCopy(file.id); setSaved(false); }
    catch { setError("Could not remove this browser copy. Close other VaultX tabs and try again."); }
    finally { setBusy(false); }
  }
  return <section className="mt-6 border-t border-line pt-6" aria-label="Offline access">
    <p className="text-sm font-medium">Selected offline access</p>
    <p className="mt-2 text-xs leading-5 text-muted">Save only this file&apos;s encrypted ciphertext and encrypted details on this device. The offline viewer asks for your separate vault passphrase. Browser storage can be evicted or cleared.</p>
    <div className="mt-3 flex flex-wrap gap-2">
      {saved ? <Button type="button" variant="secondary" disabled={busy} onClick={() => void remove()}>Remove offline copy</Button>
        : <Button type="button" variant="secondary" disabled={busy} onClick={() => void save()}>{busy ? `Saving ciphertext ${progress}%` : "Keep encrypted copy offline"}</Button>}
      {busy && <Button type="button" variant="ghost" onClick={() => controller.current?.abort()}>Cancel</Button>}
      <a href="/offline-vault.html" className="inline-flex min-h-11 items-center rounded-xl px-3 text-sm text-accent focus-visible:outline-2 focus-visible:outline-accent">Open offline viewer</a>
    </div>
    {error && <p role="alert" className="mt-3 text-sm text-danger">{error}</p>}
  </section>;
}

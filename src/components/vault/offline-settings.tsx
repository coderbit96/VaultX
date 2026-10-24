"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { clearOfflineCopies, listOfflineCopies } from "@/lib/offline/copies";

export function OfflineSettings() {
  const [count, setCount] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => { void listOfflineCopies().then((items) => setCount(items.length)).catch(() => setMessage("Browser offline storage is unavailable.")); }, []);
  async function clear() {
    if (!window.confirm("Remove all selected encrypted offline copies from this browser? Online files stay in your vault.")) return;
    setBusy(true); setMessage("");
    try { await clearOfflineCopies(); setCount(0); setMessage("Encrypted offline copies were removed from this browser."); }
    catch { setMessage("Could not clear copies. Close other VaultX tabs and retry."); }
    finally { setBusy(false); }
  }
  return <section className="mt-8 rounded-3xl border border-line bg-surface p-6 sm:p-8" aria-labelledby="offline-heading">
    <h2 id="offline-heading" className="text-xl font-semibold">Encrypted offline copies</h2>
    <p className="mt-3 text-sm leading-6 text-muted">{count === null ? "Checking this browser…" : `${count} selected file${count === 1 ? "" : "s"} saved on this browser.`} Select files from their details pages. Downloads from the offline viewer require your separate vault passphrase, even if a PIN or passkey is enabled.</p>
    <p className="mt-2 text-xs leading-5 text-muted">Browser quota and eviction rules vary. Clearing site data, running low on space, or app updates may remove offline access. Cloud deletions on another device cannot reach a disconnected browser; reconnect to check for changes.</p>
    <Button className="mt-4" type="button" variant="secondary" disabled={busy || count === 0} onClick={() => void clear()}>Clear offline copies</Button>
    {message && <p role="status" className="mt-3 text-sm text-muted">{message}</p>}
  </section>;
}

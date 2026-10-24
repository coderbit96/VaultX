"use client";

import { useState } from "react";
import { Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { clearVaultKeyMaterial, hasVaultRootKey } from "@/lib/crypto/key-memory";
import { announceFileDeleting } from "@/lib/files/deletion-events";

export function FileDelete({ id, name, onQueued }: { id: string; name: string; onQueued: () => void }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function confirm() {
    if (busy || !hasVaultRootKey()) return;
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/files/${id}`, { method: "DELETE", credentials: "same-origin", cache: "no-store" });
      if (response.status === 401) { clearVaultKeyMaterial(); window.location.replace("/unlock"); return; }
      if (response.status === 404) throw new Error("This file is no longer available. Refresh the file list.");
      if (response.status === 409) throw new Error("This file cannot be queued safely. Check Deletions or try again later.");
      if (!response.ok) throw new Error("The deletion result is uncertain. Open Deletions and refresh before trying again.");
      // A successful response means the file has been fenced in MongoDB even if
      // Cloudinary or final metadata removal is still pending.
      onQueued();
      announceFileDeleting(id);
      setOpen(false);
      router.push("/vault/deletions");
    } catch (reason) { onQueued(); setError(reason instanceof Error ? reason.message : "The deletion result is uncertain. Check Deletions."); }
    finally { setBusy(false); }
  }
  return <>
    <Button type="button" variant="danger" onClick={() => { setError(""); setOpen(true); }}><Trash2 size={17} aria-hidden="true" />Delete permanently</Button>
    <Dialog open={open} onOpenChange={(value) => { if (!busy) setOpen(value); }}>
      <DialogContent><DialogTitle>Delete this file permanently?</DialogTitle>
        <DialogDescription><span className="break-words font-medium text-foreground">{name}</span> will disappear from VaultX as soon as the deletion job is queued. Its encrypted file and any encrypted thumbnail will be removed from active Cloudinary storage before the MongoDB record is removed.</DialogDescription>
        <p className="mt-4 text-xs leading-5 text-muted">Cloudinary CDN invalidation can take time. Provider backups, downloads, and copies outside VaultX may remain.</p>
        {error && <p role="alert" className="mt-4 text-sm text-danger">{error}</p>}
        <div className="mt-6 flex flex-wrap justify-end gap-2"><DialogClose asChild><Button type="button" variant="secondary" disabled={busy}>Cancel</Button></DialogClose>
          <Button type="button" variant="danger" disabled={busy} onClick={() => void confirm()}>{busy ? "Queuing deletion…" : "Delete this file"}</Button></div>
      </DialogContent>
    </Dialog>
  </>;
}

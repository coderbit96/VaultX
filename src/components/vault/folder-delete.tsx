"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { clearVaultKeyMaterial, hasVaultRootKey } from "@/lib/crypto/key-memory";
import { announceFolderDeleting } from "@/lib/files/deletion-events";

type Preview = { folderCount: number; fileCount: number; objectCount: number };

export function FolderDelete({ id, name }: { id: string; name: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!open || !hasVaultRootKey()) return;
    const controller = new AbortController();
    queueMicrotask(() => { setLoading(true); setPreview(null); setError(""); });
    void fetch(`/api/folders/${id}`, { credentials: "same-origin", cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (response.status === 401) { clearVaultKeyMaterial(); window.location.replace("/unlock"); return; }
        if (response.status === 409) throw new Error("Finish pending uploads or deletions inside this folder, then try again.");
        if (!response.ok) throw new Error("Could not count this folder. Refresh and try again.");
        const data = await response.json() as Preview;
        if (!controller.signal.aborted) setPreview(data);
      }).catch((reason) => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Count unavailable."); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [id, open]);
  async function confirm() {
    if (!preview || busy || !hasVaultRootKey()) return;
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/folders/${id}`, { method: "DELETE", credentials: "same-origin", cache: "no-store",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify(preview) });
      if (response.status === 401) { clearVaultKeyMaterial(); window.location.replace("/unlock"); return; }
      if (response.status === 409) throw new Error("The folder changed or has pending uploads. No deletion started; refresh and try again.");
      if (response.status === 404) throw new Error("This folder is no longer available. Refresh your files.");
      if (!response.ok) throw new Error("Deletion status is uncertain. Open Deletions and refresh before trying again.");
      announceFolderDeleting();
      setOpen(false);
      router.push("/vault/deletions");
    } catch (reason) { announceFolderDeleting(); setError(reason instanceof Error ? reason.message : "Deletion status is uncertain."); }
    finally { setBusy(false); }
  }
  return <>
    <button type="button" onClick={() => { setPreview(null); setError(""); setOpen(true); }} className="flex min-h-11 w-full items-center gap-2 rounded-lg px-3 text-left text-sm text-danger hover:bg-danger/10 focus-visible:outline-2 focus-visible:outline-accent"><Trash2 size={16} aria-hidden="true" />Delete permanently</button>
    <Dialog open={open} onOpenChange={(value) => { if (!busy) setOpen(value); }}>
      <DialogContent><DialogTitle>Delete this folder and everything inside?</DialogTitle>
        <DialogDescription><span className="break-words font-medium text-foreground">{name}</span> and all its nested folders and files will disappear from VaultX when the durable deletion job starts.</DialogDescription>
        {loading && <p role="status" className="mt-4 text-sm text-muted">Counting folders and files…</p>}
        {preview && <p className="mt-4 rounded-xl border border-danger/30 bg-danger/5 p-4 text-sm text-foreground">
          {preview.folderCount.toLocaleString()} folder{preview.folderCount === 1 ? "" : "s"}, {preview.fileCount.toLocaleString()} file{preview.fileCount === 1 ? "" : "s"}, and {preview.objectCount.toLocaleString()} encrypted Cloudinary object{preview.objectCount === 1 ? "" : "s"} are in this subtree. Counts are checked again when you confirm.
        </p>}
        {error && <p role="alert" className="mt-4 text-sm text-danger">{error}</p>}
        <p className="mt-4 text-xs leading-5 text-muted">Completion waits for active Cloudinary objects and MongoDB records to be confirmed removed. CDN invalidation and provider backups may take longer.</p>
        <div className="mt-6 flex flex-wrap justify-end gap-2"><DialogClose asChild><Button type="button" variant="secondary" disabled={busy}>Cancel</Button></DialogClose>
          <Button type="button" variant="danger" disabled={busy || !preview} onClick={() => void confirm()}>{busy ? "Starting deletion…" : "Delete this folder"}</Button></div>
      </DialogContent>
    </Dialog>
  </>;
}

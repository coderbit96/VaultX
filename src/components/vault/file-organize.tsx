"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowLeft, ChevronRight, Folder, Pencil, MoveRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { decryptFolderName } from "@/lib/crypto/folder-names";
import { encryptFileName } from "@/lib/crypto/file-names";
import { clearVaultKeyMaterial, hasVaultRootKey } from "@/lib/crypto/key-memory";
import type { EncryptedFolderName } from "@/lib/crypto/folder-name-schema";

type Folder = { id: string; name: string };
type FolderPage = { path: Folder[]; folders: Folder[]; nextCursor: string | null };
type WireFolder = { id: string; nameEncrypted: EncryptedFolderName };

async function fetchFolderPage(parentId: string | null, after: string | null, signal: AbortSignal): Promise<FolderPage> {
  const query = new URLSearchParams();
  if (parentId) query.set("parentId", parentId);
  if (after) query.set("after", after);
  const response = await fetch(`/api/folders?${query}`, { credentials: "same-origin", cache: "no-store", signal });
  if (response.status === 401) { clearVaultKeyMaterial(); window.location.replace("/unlock"); throw new Error("locked"); }
  if (!response.ok) throw new Error("Could not load folders. Try again.");
  const data = await response.json() as { path: WireFolder[]; folders: WireFolder[]; nextCursor: string | null };
  const decrypt = async (folder: WireFolder): Promise<Folder> => ({ id: folder.id, name: await decryptFolderName(folder.id, folder.nameEncrypted) });
  const [path, folders] = await Promise.all([Promise.all(data.path.map(decrypt)), Promise.all(data.folders.map(decrypt))]);
  return { path, folders, nextCursor: data.nextCursor };
}

export function FileOrganize({ id, name, extension, onSaved }: { id: string; name: string; extension: string; onSaved: () => void }) {
  const [action, setAction] = useState<"rename" | "move" | null>(null);
  const [draft, setDraft] = useState("");
  const [destination, setDestination] = useState<string | null>(null);
  const [page, setPage] = useState<FolderPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const request = useRef<AbortController | null>(null);
  const epoch = useRef(0);
  const suffix = extension ? `.${extension}` : "";
  const openRename = () => { setDraft(suffix && name.toLowerCase().endsWith(suffix) ? name.slice(0, -suffix.length) : name); setError(""); setAction("rename"); };
  const openMove = () => { setDestination(null); setPage(null); setError(""); setAction("move"); };
  useEffect(() => {
    if (action !== "move" || !hasVaultRootKey()) return;
    const started = ++epoch.current;
    request.current?.abort(); const controller = new AbortController(); request.current = controller;
    queueMicrotask(() => { if (started === epoch.current) { setPage(null); setLoading(true); } });
    void fetchFolderPage(destination, null, controller.signal).then((result) => {
      if (started === epoch.current && hasVaultRootKey()) { setPage(result); setLoading(false); }
    }).catch((reason) => { if (started === epoch.current && !controller.signal.aborted) { setError(reason instanceof Error ? reason.message : "Could not load folders."); setLoading(false); } });
    return () => { controller.abort(); };
  }, [action, destination, retry]);
  useEffect(() => {
    const clear = () => { epoch.current++; request.current?.abort(); setAction(null); setDraft(""); setPage(null); setError(""); };
    window.addEventListener("vaultx:key-clear", clear);
    return () => { request.current?.abort(); window.removeEventListener("vaultx:key-clear", clear); };
  }, []);
  async function loadMore() {
    if (!page?.nextCursor || loading) return;
    const started = ++epoch.current;
    request.current?.abort(); const controller = new AbortController(); request.current = controller;
    setLoading(true); setError("");
    try {
      const more = await fetchFolderPage(destination, page.nextCursor, controller.signal);
      if (started === epoch.current && hasVaultRootKey()) setPage({ ...more, folders: [...page.folders, ...more.folders] });
    } catch (reason) { if (started === epoch.current && !controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Could not load folders."); }
    finally { if (started === epoch.current) setLoading(false); }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!action || busy || !hasVaultRootKey()) return;
    setBusy(true); setError("");
    try {
      const body = action === "rename" ? { nameEncrypted: await encryptFileName(id, `${draft.trim()}${suffix}`) } : { folderId: destination };
      const response = await fetch(`/api/files/${id}`, { method: "PATCH", credentials: "same-origin", cache: "no-store",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (response.status === 401) { clearVaultKeyMaterial(); window.location.replace("/unlock"); return; }
      if (response.status === 404) throw new Error("The file or destination is unavailable. Refresh and try again.");
      if (response.status === 400) throw new Error("Check the name or destination and try again.");
      if (!response.ok) throw new Error("Could not save the change. Try again.");
      if (!hasVaultRootKey()) return;
      setAction(null); setDraft(""); setPage(null); onSaved();
    } catch (reason) { if (hasVaultRootKey()) setError(reason instanceof Error ? reason.message : "Could not save the change."); }
    finally { setBusy(false); }
  }
  return <>
    <Button type="button" variant="secondary" onClick={openRename}><Pencil size={17} aria-hidden="true" />Rename</Button>
    <Button type="button" variant="secondary" onClick={openMove}><MoveRight size={17} aria-hidden="true" />Move</Button>
    <Dialog open={action !== null} onOpenChange={(open) => { if (!open && !busy) { setAction(null); setError(""); } }}>
      <DialogContent><DialogTitle>{action === "rename" ? "Rename file" : "Move file"}</DialogTitle>
        <DialogDescription>{action === "rename" ? `The stored format stays ${suffix || "unchanged"}. The new display name is encrypted in this browser.` : "Choose a destination folder. The file stays encrypted and keeps the same ID."}</DialogDescription>
        {action === "move" && <div className="mt-5 space-y-3">
          <div className="flex items-center gap-2"><Button type="button" variant="secondary" size="icon" aria-label="Back one folder" disabled={!destination || !page} onClick={() => setDestination(page?.path.at(-2)?.id ?? null)}><ArrowLeft size={17} /></Button><span className="min-w-0 truncate text-sm">Destination: {page?.path.at(-1)?.name ?? "Root"}</span></div>
          <div className="max-h-64 overflow-y-auto rounded-xl border border-line bg-surface p-2" aria-label="Destination folders">
            {loading && !page && <p role="status" className="p-3 text-sm text-muted">Loading folders…</p>}
            {!loading && !page && <Button type="button" variant="secondary" onClick={() => { setError(""); setRetry((value) => value + 1); }}>Try again</Button>}
            {page?.folders.length === 0 && <p className="p-3 text-sm text-muted">No child folders here.</p>}
            {page?.folders.map((folder) => <button key={folder.id} type="button" onClick={() => setDestination(folder.id)} className="flex min-h-11 w-full items-center gap-2 rounded-lg px-3 text-left text-sm hover:bg-raised focus-visible:outline-2 focus-visible:outline-accent"><Folder size={17} className="text-accent" /><span className="truncate">{folder.name}</span><ChevronRight size={16} className="ml-auto" /></button>)}
          </div>
          {page?.nextCursor && <Button type="button" variant="secondary" disabled={loading} onClick={() => void loadMore()}>Load more folders</Button>}
        </div>}
        <form onSubmit={submit} className="mt-5 space-y-4">
          {action === "rename" && <label className="block text-sm font-medium">Name before {suffix || "extension"}<span className="mt-2 flex items-center gap-2"><Input value={draft} onChange={(event) => setDraft(event.target.value)} maxLength={Math.max(1, 120 - suffix.length)} required disabled={busy} autoFocus /><span className="text-muted">{suffix}</span></span></label>}
          {error && <p role="alert" className="text-sm text-danger">{error}</p>}
          <div className="flex justify-end gap-2"><DialogClose asChild><Button type="button" variant="secondary" disabled={busy}>Cancel</Button></DialogClose><Button type="submit" disabled={busy || (action === "move" && (!page || loading))}>{busy ? "Saving…" : action === "rename" ? "Save name" : "Move here"}</Button></div>
        </form>
      </DialogContent>
    </Dialog>
  </>;
}

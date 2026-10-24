"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowLeft, ChevronRight, Folder, FolderPlus, LockKeyhole, MoreHorizontal, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { FileList } from "@/components/vault/file-list";
import { FolderDelete } from "@/components/vault/folder-delete";
import { decryptFolderName, encryptFolderName, newFolderId } from "@/lib/crypto/folder-names";
import { clearVaultKeyMaterial, hasVaultRootKey } from "@/lib/crypto/key-memory";
import type { EncryptedFolderName } from "@/lib/crypto/folder-name-schema";
import { onFileDeleting } from "@/lib/files/deletion-events";

type WireFolder = { id: string; parentFolderId: string | null; nameEncrypted: EncryptedFolderName };
type FolderEntry = { id: string; parentFolderId: string | null; name: string };
type FolderPage = { path: FolderEntry[]; folders: FolderEntry[]; nextCursor: string | null };
type View = { status: "locked" | "loading" | "ready" | "error"; page: FolderPage | null };
type BreadcrumbCount = { folderId: string | null; fileCount: number; folderCount: number };
type Action = { type: "create" } | { type: "rename" | "move"; folder: FolderEntry };

async function loadPage(parentId: string | null, after?: string, signal?: AbortSignal): Promise<FolderPage> {
  const query = new URLSearchParams();
  if (parentId) query.set("parentId", parentId);
  if (after) query.set("after", after);
  const response = await fetch(`/api/folders?${query}`, { credentials: "same-origin", cache: "no-store", signal });
  if (response.status === 401) { clearVaultKeyMaterial(); window.location.replace("/unlock"); throw new Error("locked"); }
  if (!response.ok) throw new Error("load_failed");
  const data = await response.json() as { path: WireFolder[]; folders: WireFolder[]; nextCursor: string | null };
  const decrypt = async (folder: WireFolder): Promise<FolderEntry> => ({
    id: folder.id, parentFolderId: folder.parentFolderId,
    name: await decryptFolderName(folder.id, folder.nameEncrypted),
  });
  // Neither the path nor the list is shown until every name authenticates.
  const [path, folders] = await Promise.all([Promise.all(data.path.map(decrypt)), Promise.all(data.folders.map(decrypt))]);
  return { path, folders, nextCursor: data.nextCursor };
}

async function saveFolder(path: string, method: "POST" | "PATCH", body: Record<string, unknown>): Promise<void> {
  const response = await fetch(path, { method, credentials: "same-origin", cache: "no-store",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (response.status === 401) { clearVaultKeyMaterial(); window.location.replace("/unlock"); throw new Error("locked"); }
  if (response.status === 404) throw new Error("That folder is unavailable. Refresh and try again.");
  if (response.status === 400) throw new Error("Check the name or destination. A folder cannot move into itself or its children.");
  if (!response.ok) throw new Error("Could not save the change. Please try again.");
}

function FolderSkeleton() {
  return <div role="status" aria-label="Loading folders" className="space-y-3">
    {[0, 1, 2].map((item) => <div key={item} className="flex items-center gap-4 rounded-2xl border border-line bg-surface p-4">
      <Skeleton className="size-12 shrink-0" /><div className="w-full space-y-2"><Skeleton className="h-4 w-2/5" /><Skeleton className="h-3 w-1/4" /></div>
    </div>)}
  </div>;
}

export function FolderBrowser({ parentId = null, initialCategory = "all" }: { parentId?: string | null; initialCategory?: "all" | "image" | "video" | "audio" | "document" | "other" }) {
  const [view, setView] = useState<View>({ status: "locked", page: null });
  const [breadcrumbCounts, setBreadcrumbCounts] = useState<BreadcrumbCount[]>([]);
  const [action, setAction] = useState<Action | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [formError, setFormError] = useState("");
  const [destination, setDestination] = useState<string | null>(null);
  const [destinationView, setDestinationView] = useState<View>({ status: "loading", page: null });
  const [destinationBusy, setDestinationBusy] = useState(false);
  const epoch = useRef(0);
  const destinationEpoch = useRef(0);
  const request = useRef<AbortController | null>(null);
  const destinationRequest = useRef<AbortController | null>(null);
  const nameInput = useRef<HTMLInputElement | null>(null);
  const destinationPanel = useRef<HTMLDivElement | null>(null);

  const refresh = useCallback(async (after?: string) => {
    if (!hasVaultRootKey()) { setView({ status: "locked", page: null }); return; }
    const started = ++epoch.current;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    if (!after) setView({ status: "loading", page: null });
    try {
      const [page, counts] = await Promise.all([loadPage(parentId, after, controller.signal), fetch(`/api/vault/summary${parentId ? `?folderId=${parentId}` : ""}`,
        { credentials: "same-origin", cache: "no-store", signal: controller.signal }).then(async (response) => {
        if (response.status === 401) { clearVaultKeyMaterial(); window.location.replace("/unlock"); throw new Error("locked"); }
        if (!response.ok) throw new Error("summary_failed");
        return (await response.json() as { breadcrumbCounts: BreadcrumbCount[] }).breadcrumbCounts;
      })]);
      if (started !== epoch.current || !hasVaultRootKey()) return;
      setBreadcrumbCounts(counts);
      setView((previous) => ({ status: "ready", page: after && previous.page
        ? { ...page, folders: [...previous.page.folders, ...page.folders] } : page }));
    } catch {
      if (started !== epoch.current || controller.signal.aborted || !hasVaultRootKey()) return;
      setView({ status: "error", page: null });
    }
  }, [parentId]);

  useEffect(() => {
    const clear = () => {
      epoch.current++;
      destinationEpoch.current++;
      request.current?.abort();
      destinationRequest.current?.abort();
      setView({ status: "locked", page: null });
      setBreadcrumbCounts([]);
      setDestinationView({ status: "locked", page: null });
      setAction(null);
      setDraft("");
      setNotice("");
      setFormError("");
      setBusy(false);
      setDestinationBusy(false);
    };
    window.addEventListener("vaultx:key-clear", clear);
    const ready = () => { void refresh(); };
    window.addEventListener("vaultx:key-ready", ready);
    const openCreate = () => { if (hasVaultRootKey()) { setDraft(""); setFormError(""); setAction({ type: "create" }); } };
    window.addEventListener("vaultx:new-folder", openCreate);
    const stopDeletion = onFileDeleting(() => { void refresh(); });
    let mounted = true;
    queueMicrotask(() => { if (mounted && hasVaultRootKey()) void refresh(); });
    return () => {
      mounted = false;
      request.current?.abort();
      destinationRequest.current?.abort();
      stopDeletion();
      window.removeEventListener("vaultx:key-clear", clear);
      window.removeEventListener("vaultx:key-ready", ready);
      window.removeEventListener("vaultx:new-folder", openCreate);
    };
  }, [refresh]);

  useEffect(() => {
    if (action?.type !== "move" || !hasVaultRootKey()) return;
    const started = ++destinationEpoch.current;
    destinationRequest.current?.abort();
    const controller = new AbortController();
    destinationRequest.current = controller;
    void loadPage(destination, undefined, controller.signal).then((page) => {
      if (started === destinationEpoch.current && hasVaultRootKey()) setDestinationView({ status: "ready", page });
    }).catch(() => {
      if (started === destinationEpoch.current && !controller.signal.aborted && hasVaultRootKey()) setDestinationView({ status: "error", page: null });
    });
    return () => { if (destinationEpoch.current === started) destinationEpoch.current = started + 1; controller.abort(); };
  }, [action, destination]);

  const openCreate = () => { setDraft(""); setFormError(""); setAction({ type: "create" }); };
  const openRename = (folder: FolderEntry) => { setDraft(folder.name); setFormError(""); setAction({ type: "rename", folder }); };
  const openMove = (folder: FolderEntry) => { setDestination(null); setDestinationView({ status: "loading", page: null }); setFormError(""); setAction({ type: "move", folder }); };
  const chooseDestination = (id: string | null) => { setDestinationView({ status: "loading", page: null }); setDestination(id); };
  const loadMoreDestinations = async () => {
    const cursor = destinationView.page?.nextCursor;
    if (!cursor || destinationBusy) return;
    const started = ++destinationEpoch.current;
    destinationRequest.current?.abort();
    const controller = new AbortController();
    destinationRequest.current = controller;
    setDestinationBusy(true);
    try {
      const extra = await loadPage(destination, cursor, controller.signal);
      if (started === destinationEpoch.current && hasVaultRootKey()) setDestinationView((previous) => ({ status: "ready", page: previous.page
        ? { ...extra, folders: [...previous.page.folders, ...extra.folders] } : extra }));
    } catch {
      if (started === destinationEpoch.current && !controller.signal.aborted && hasVaultRootKey()) setFormError("Could not load more destinations. Try again.");
    } finally { if (started === destinationEpoch.current) setDestinationBusy(false); }
  };
  const closeAction = () => { if (!busy) { destinationEpoch.current++; destinationRequest.current?.abort(); setAction(null); setDraft(""); setFormError(""); setDestinationView({ status: "loading", page: null }); } };

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!action || busy || !hasVaultRootKey()) return;
    setBusy(true); setFormError(""); setNotice("");
    const started = epoch.current;
    try {
      if (action.type === "create") {
        const id = newFolderId();
        await saveFolder("/api/folders", "POST", { id, parentFolderId: parentId, nameEncrypted: await encryptFolderName(id, draft) });
      } else if (action.type === "rename") {
        await saveFolder(`/api/folders/${action.folder.id}`, "PATCH", { nameEncrypted: await encryptFolderName(action.folder.id, draft) });
      } else {
        await saveFolder(`/api/folders/${action.folder.id}`, "PATCH", { parentFolderId: destination });
      }
      if (started !== epoch.current || !hasVaultRootKey()) return;
      destinationEpoch.current++; destinationRequest.current?.abort();
      setBusy(false);
      setAction(null); setDraft(""); setDestinationView({ status: "loading", page: null });
      setNotice(action.type === "create" ? "Folder created." : action.type === "rename" ? "Folder renamed." : "Folder moved.");
      await refresh();
    } catch (error) {
      if (started === epoch.current && hasVaultRootKey()) setFormError(error instanceof Error ? error.message : "Could not save the change.");
    } finally { if (started === epoch.current) setBusy(false); }
  }

  const page = view.page;
  const parent = page?.path.at(-2);
  const heading = parentId && page?.path.length ? page.path[page.path.length - 1].name : "All folders";
  const destinationPage = destinationView.page;
  const invalidDestination = action?.type === "move" && (action.folder.id === destination || !!destinationPage?.path.some((item) => item.id === action.folder.id));

  return <div className="space-y-7">
    <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <p className="text-xs font-semibold uppercase tracking-[0.22em] text-accent">Private library / Files</p>
        <h1 className="mt-2 break-words text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">{view.status === "ready" ? heading : "Files"}</h1>
        <p className="mt-3 max-w-xl text-sm leading-6 text-muted">Organize encrypted folders and ready files.</p>
        {view.status === "ready" && breadcrumbCounts.length > 0 && <p className="mt-2 text-xs text-muted">{breadcrumbCounts.at(-1)!.folderCount.toLocaleString()} folders · {breadcrumbCounts.at(-1)!.fileCount.toLocaleString()} ready files here</p>}
      </div>
      {view.status === "ready" && <Button type="button" onClick={openCreate} className="w-full shrink-0 sm:w-auto"><FolderPlus aria-hidden="true" size={18} />New folder</Button>}
    </div>

    {view.status === "locked" ? <EmptyState icon={<LockKeyhole size={24} />} title="Vault key locked"
      description="Unlock your vault key in Settings to decrypt folder names on this device."
      action={<Link href="/vault/settings" className="inline-flex min-h-11 items-center rounded-xl bg-accent px-5 text-sm font-medium text-accent-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">Open Settings</Link>} /> : <>
      <div className="flex min-w-0 items-center gap-3">
        {parentId && <Link href={parent ? `/vault/folders/${parent.id}` : "/vault/files"} aria-label="Back to parent folder" className="inline-flex size-11 shrink-0 items-center justify-center rounded-xl border border-line bg-surface text-foreground hover:bg-raised focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"><ArrowLeft aria-hidden="true" size={19} /></Link>}
        <nav aria-label="Folder breadcrumb" className="min-w-0 overflow-x-auto rounded-xl border border-line bg-surface px-3 py-2">
          <ol className="flex min-w-max items-center gap-1 text-sm"><li><Link href="/vault/files" className="inline-flex min-h-8 items-center rounded px-2 text-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-accent">Files <span className="ml-1 text-xs">({breadcrumbCounts[0]?.fileCount ?? 0})</span></Link></li>
            {page?.path.map((folder) => <li key={folder.id} className="flex items-center gap-1"><ChevronRight aria-hidden="true" size={15} className="text-line-strong" />
              <Link href={`/vault/folders/${folder.id}`} aria-current={folder.id === parentId ? "page" : undefined} className="inline-flex min-h-8 max-w-48 items-center truncate rounded px-2 text-foreground hover:text-accent focus-visible:outline-2 focus-visible:outline-accent">{folder.name} <span className="ml-1 text-xs text-muted">({breadcrumbCounts.find((item) => item.folderId === folder.id)?.fileCount ?? 0})</span></Link></li>)}</ol>
        </nav>
      </div>
      {notice && <p role="status" className="rounded-xl border border-accent/25 bg-accent/5 px-4 py-3 text-sm text-accent">{notice}</p>}
      {view.status === "loading" && <FolderSkeleton />}
      {view.status === "error" && <EmptyState icon={<Folder size={24} />} title="Folders could not be opened"
        description="Check your connection and vault key, then try again. No folder data was changed."
        action={<Button type="button" onClick={() => void refresh()}>Try again</Button>} />}
      {view.status === "ready" && page && <section aria-label="Folders" className="space-y-4">
        <div className="flex items-center justify-between gap-3 border-b border-line pb-3"><h2 className="text-sm font-semibold uppercase tracking-[0.15em] text-muted">Folders</h2><span className="text-xs text-muted">{page.folders.length}{page.nextCursor ? "+" : ""} shown</span></div>
        {page.folders.length === 0 ? <EmptyState icon={<FolderPlus size={24} />} title="No folders here yet"
          description="Create a folder to organize this part of your vault."
          action={<Button type="button" onClick={openCreate}><Plus aria-hidden="true" size={17} />Create folder</Button>} /> :
          <ul className="grid gap-3 lg:grid-cols-2">{page.folders.map((folder) => <li key={folder.id} className="group flex min-w-0 items-center gap-3 rounded-2xl border border-line bg-surface p-3 transition-colors hover:border-line-strong hover:bg-raised motion-reduce:transition-none sm:p-4">
            <span aria-hidden="true" className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent"><Folder size={23} strokeWidth={1.7} /></span>
            <Link href={`/vault/folders/${folder.id}`} className="flex min-h-12 min-w-0 flex-1 items-center rounded-lg text-sm font-medium text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"><span className="truncate">{folder.name}</span><ChevronRight aria-hidden="true" size={17} className="ml-auto shrink-0 text-muted" /></Link>
            <details className="relative shrink-0"><summary aria-label={`Actions for ${folder.name}`} className="flex size-11 cursor-pointer list-none items-center justify-center rounded-xl text-muted hover:bg-elevated hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent [&::-webkit-details-marker]:hidden"><MoreHorizontal aria-hidden="true" size={20} /></summary>
              <div className="absolute right-0 top-full z-20 mt-2 w-44 rounded-xl border border-line-strong bg-raised p-1 shadow-2xl">
                <button type="button" onClick={() => openRename(folder)} className="flex min-h-11 w-full items-center rounded-lg px-3 text-left text-sm hover:bg-elevated focus-visible:outline-2 focus-visible:outline-accent">Rename</button>
                <button type="button" onClick={() => openMove(folder)} className="flex min-h-11 w-full items-center rounded-lg px-3 text-left text-sm hover:bg-elevated focus-visible:outline-2 focus-visible:outline-accent">Move</button>
                <FolderDelete id={folder.id} name={folder.name} />
              </div>
            </details>
          </li>)}</ul>}
        {page.nextCursor && <div className="flex justify-center pt-2"><Button type="button" variant="secondary" onClick={() => void refresh(page.nextCursor ?? undefined)}>Load more folders</Button></div>}
      </section>}
      {view.status === "ready" && <FileList key={parentId ?? "root"} folderId={parentId} initialCategory={initialCategory} />}
    </>}

    <Dialog open={action !== null} onOpenChange={(open) => { if (!open) closeAction(); }}>
      <DialogContent onOpenAutoFocus={(event) => { event.preventDefault();
        if (action?.type === "move") destinationPanel.current?.focus(); else nameInput.current?.focus(); }}>
        <DialogTitle>{action?.type === "create" ? "New folder" : action?.type === "rename" ? "Rename folder" : "Move folder"}</DialogTitle>
        <DialogDescription>{action?.type === "create" ? "Its name is encrypted here before it is saved." : action?.type === "rename" ? "Renaming keeps the folder and its contents in place." : "Choose a destination from your folders. Moving keeps the folder ID and contents."}</DialogDescription>
        {action?.type === "move" ? <form onSubmit={submit} className="mt-6 space-y-4">
          <div className="flex items-center gap-2"><Button type="button" variant="secondary" size="icon" aria-label="Back one destination level" disabled={destination === null || destinationView.status !== "ready"} onClick={() => chooseDestination(destinationPage?.path.at(-2)?.id ?? null)}><ArrowLeft aria-hidden="true" size={18} /></Button>
            <p className="min-w-0 truncate text-sm font-medium">Destination: {destinationPage?.path.at(-1)?.name ?? "Root"}</p></div>
          <div ref={destinationPanel} tabIndex={-1} className="max-h-64 space-y-1 overflow-y-auto rounded-xl border border-line bg-surface p-2 focus-visible:outline-2 focus-visible:outline-accent" aria-label="Choose destination folder">
            {destinationView.status === "loading" && <p role="status" className="p-3 text-sm text-muted">Loading destinations…</p>}
            {destinationView.status === "error" && <p role="alert" className="p-3 text-sm text-danger">Could not load destinations. Close and try again.</p>}
            {destinationView.status === "ready" && destinationPage?.folders.length === 0 && <p className="p-3 text-sm text-muted">No child folders here.</p>}
            {destinationView.status === "ready" && destinationPage?.folders.filter((folder) => folder.id !== action.folder.id).map((folder) => <button key={folder.id} type="button" onClick={() => chooseDestination(folder.id)} className="flex min-h-11 w-full items-center gap-3 rounded-lg px-3 text-left text-sm hover:bg-raised focus-visible:outline-2 focus-visible:outline-accent"><Folder aria-hidden="true" size={17} className="shrink-0 text-accent" /><span className="truncate">{folder.name}</span><ChevronRight aria-hidden="true" size={16} className="ml-auto shrink-0 text-muted" /></button>)}
          </div>
          {destinationView.status === "ready" && destinationPage?.nextCursor && <Button type="button" variant="secondary" disabled={destinationBusy} onClick={() => void loadMoreDestinations()}>{destinationBusy ? "Loading…" : "Load more destinations"}</Button>}
          {invalidDestination && <p role="alert" className="text-sm text-danger">A folder cannot move into itself or a child.</p>}
          {formError && <p role="alert" className="text-sm text-danger">{formError}</p>}
          <div className="flex justify-end gap-2"><DialogClose asChild><Button type="button" variant="secondary" disabled={busy}>Cancel</Button></DialogClose><Button type="submit" disabled={busy || destinationView.status !== "ready" || invalidDestination}>Move here</Button></div>
        </form> : <form onSubmit={submit} className="mt-6 space-y-4">
          <div><label htmlFor="folder-dialog-name" className="mb-2 block text-sm font-medium">Folder name</label><Input ref={nameInput} id="folder-dialog-name" value={draft} onChange={(event) => setDraft(event.target.value)} maxLength={120} required disabled={busy} /></div>
          {formError && <p role="alert" className="text-sm text-danger">{formError}</p>}
          <div className="flex justify-end gap-2"><DialogClose asChild><Button type="button" variant="secondary" disabled={busy}>Cancel</Button></DialogClose><Button type="submit" disabled={busy}>{busy ? "Saving…" : action?.type === "create" ? "Create folder" : "Save name"}</Button></div>
        </form>}
      </DialogContent>
    </Dialog>
  </div>;
}

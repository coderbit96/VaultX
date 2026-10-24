"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { FileIcon } from "@/components/ui/file-icon";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { decryptFileName } from "@/lib/crypto/file-names";
import { clearVaultKeyMaterial, hasVaultRootKey } from "@/lib/crypto/key-memory";
import type { FilePublicMetadata } from "@/types/files";
import { filterAndSortFiles, type FileFilter, type FileSort } from "@/lib/files/browse";
import { onFileDeleting } from "@/lib/files/deletion-events";
import { onFileReady } from "@/lib/files/ready-events";

type FileEntry = FilePublicMetadata & { name: string };
type FilePage = { files: FileEntry[]; nextCursor: string | null };
type View = { status: "locked" | "loading" | "ready" | "error"; page: FilePage | null };

async function fetchFiles(folderId: string | null, allFolders: boolean, category: FileFilter, after: string | null, signal: AbortSignal): Promise<FilePage> {
  const query = new URLSearchParams();
  if (allFolders) query.set("scope", "all");
  else if (folderId) query.set("folderId", folderId);
  if (after) query.set("after", after);
  if (category !== "all") query.set("category", category);
  const response = await fetch(`/api/files?${query}`, { credentials: "same-origin", cache: "no-store", signal });
  if (response.status === 401) { clearVaultKeyMaterial(); window.location.replace("/unlock"); throw new Error("locked"); }
  if (!response.ok) throw new Error("load_failed");
  const data = await response.json() as { files: FilePublicMetadata[]; nextCursor: string | null };
  const files = await Promise.all(data.files.map(async (file) => ({ ...file, name: await decryptFileName(file.id, file.nameEncrypted) })));
  return { files, nextCursor: data.nextCursor };
}

function formattedBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${(bytes / 1000).toFixed(1)} KB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

export function FileList({ folderId, initialCategory = "all" }: { folderId: string | null; initialCategory?: FileFilter }) {
  const [view, setView] = useState<View>({ status: "locked", page: null });
  const [query, setQuery] = useState("");
  const search = useRef("");
  const [category, setCategory] = useState<FileFilter>(initialCategory);
  const [sort, setSort] = useState<FileSort>("date-new");
  const controls = useRef({ category, sort });
  const epoch = useRef(0);
  const request = useRef<AbortController | null>(null);

  const load = useCallback(async (search: string, filter: FileFilter, order: FileSort, after: string | null = null) => {
    if (!hasVaultRootKey()) { setView({ status: "locked", page: null }); return; }
    const started = ++epoch.current;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    if (!after) setView({ status: "loading", page: null });
    try {
      const allFolders = !!search.trim() || filter !== "all";
      const loadAll = allFolders || order !== "date-new";
      let page = await fetchFiles(folderId, allFolders, filter, after, controller.signal);
      if (loadAll) {
        const found = [...page.files];
        while (page.nextCursor) {
          if (controller.signal.aborted || !hasVaultRootKey()) return;
          page = await fetchFiles(folderId, allFolders, filter, page.nextCursor, controller.signal);
          found.push(...page.files);
        }
        page = { files: filterAndSortFiles(found, search, filter, order), nextCursor: null };
      }
      if (started !== epoch.current || !hasVaultRootKey()) return;
      setView((previous) => ({ status: "ready", page: after && previous.page
        ? { files: [...previous.page.files, ...page.files], nextCursor: page.nextCursor } : page }));
    } catch {
      if (started !== epoch.current || controller.signal.aborted || !hasVaultRootKey()) return;
      setView({ status: "error", page: null });
    }
  }, [folderId]);

  useEffect(() => {
    const clear = () => { epoch.current++; request.current?.abort(); search.current = ""; setQuery(""); setView({ status: "locked", page: null }); };
    const ready = () => { void load("", controls.current.category, controls.current.sort); };
    window.addEventListener("vaultx:key-clear", clear);
    window.addEventListener("vaultx:key-ready", ready);
    const stopDeletion = onFileDeleting(() => { void load(search.current, controls.current.category, controls.current.sort); });
    const stopReady = onFileReady(() => { void load(search.current, controls.current.category, controls.current.sort); });
    let mounted = true;
    queueMicrotask(() => { if (mounted && hasVaultRootKey()) void load("", controls.current.category, controls.current.sort); });
    return () => { mounted = false; request.current?.abort(); stopDeletion(); stopReady(); window.removeEventListener("vaultx:key-clear", clear); window.removeEventListener("vaultx:key-ready", ready); };
  }, [load]);

  useEffect(() => {
    if (!hasVaultRootKey() || !query) return;
    const timer = setTimeout(() => { void load(query, controls.current.category, controls.current.sort); }, 250);
    return () => clearTimeout(timer);
  }, [query, load]);

  if (view.status === "locked") return null;
  const page = view.page;
  return <section aria-label="Files" className="space-y-4">
    <div className="flex flex-col gap-3 border-b border-line pb-3 sm:flex-row sm:items-center sm:justify-between">
      <div><h2 className="text-sm font-semibold uppercase tracking-[0.15em] text-muted">Files</h2>
        <p className="mt-1 text-xs text-muted">Search decrypts filenames here on your device across your ready files.</p></div>
      <label className="relative block w-full sm:max-w-xs"><span className="sr-only">Search filenames</span>
        <Search aria-hidden="true" size={17} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
        <Input aria-label="Search filenames" value={query} onChange={(event) => {
          epoch.current++; request.current?.abort(); setView({ status: "loading", page: null });
          search.current = event.target.value; setQuery(event.target.value); if (!event.target.value) void load("", category, sort);
        }}
          placeholder="Search filenames" className="pl-10" maxLength={120} /></label>
    </div>
    <div className="flex flex-wrap gap-3"><label className="flex min-w-40 flex-1 flex-col gap-1 text-xs text-muted">Type
      <select aria-label="Filter files by type" value={category} onChange={(event) => { const next = event.target.value as FileFilter; controls.current.category = next; setCategory(next); void load(query, next, sort); }} className="min-h-11 rounded-xl border border-line bg-input px-3 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-accent">
        <option value="all">All types</option><option value="image">Images</option><option value="video">Videos</option><option value="audio">Audio</option><option value="document">Documents</option><option value="other">Other</option>
      </select></label><label className="flex min-w-40 flex-1 flex-col gap-1 text-xs text-muted">Sort
      <select aria-label="Sort files" value={sort} onChange={(event) => { const next = event.target.value as FileSort; controls.current.sort = next; setSort(next); void load(query, category, next); }} className="min-h-11 rounded-xl border border-line bg-input px-3 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-accent">
        <option value="date-new">Newest</option><option value="date-old">Oldest</option><option value="name">Name</option><option value="type">Type</option><option value="size-large">Largest</option><option value="size-small">Smallest</option>
      </select></label></div>
    {view.status === "loading" && <div role="status" aria-label={query ? "Searching files" : "Loading files"} className="space-y-3">
      {[0, 1].map((item) => <Skeleton key={item} className="h-20 rounded-2xl" />)}</div>}
    {view.status === "error" && <EmptyState icon={<Search size={24} />} title="Files could not be opened"
      description="Check your connection and vault key, then try again."
      action={<Button type="button" onClick={() => void load(query, category, sort)}>Try again</Button>} />}
    {view.status === "ready" && page && (page.files.length === 0 ?
      <EmptyState icon={<Search size={24} />} title={query || category !== "all" ? "No matching files" : "No ready files here"}
        description={query || category !== "all" ? "Try another name or type. Search stays on this device." : "Completed encrypted uploads will appear here."} /> :
      <ul className="grid gap-3 lg:grid-cols-2">{page.files.map((file) => <li key={file.id}>
        <Link href={`/vault/files/${file.id}`} className="flex min-h-20 min-w-0 items-center gap-3 rounded-2xl border border-line bg-surface p-3 transition-colors hover:border-line-strong hover:bg-raised focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent motion-reduce:transition-none sm:p-4">
          <FileIcon category={file.category} />
          <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium text-foreground">{file.name}</span>
            <span className="mt-1 block text-xs text-muted">{file.extension ? file.extension.toUpperCase() : file.category} · {formattedBytes(file.storedSizeBytes)} stored ciphertext</span></span>
        </Link></li>)}</ul>)}
    {view.status === "ready" && page && <p className="text-xs text-muted">{page.files.length.toLocaleString()}{page.nextCursor ? "+" : ""} files shown</p>}
    {view.status === "ready" && page?.nextCursor && !query && category === "all" && sort === "date-new" && <div className="flex justify-center"><Button type="button" variant="secondary" onClick={() => void load("", category, sort, page.nextCursor)}>Load more files</Button></div>}
  </section>;
}

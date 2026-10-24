"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Download, ImageIcon, Plus, Trash2, Video } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { UploadManager } from "@/components/vault/upload-manager";
import { VaultKeySettings } from "@/components/vault/vault-key-settings";
import { decryptFileName } from "@/lib/crypto/file-names";
import { clearVaultKeyMaterial, hasVaultRootKey } from "@/lib/crypto/key-memory";
import { chooseDownloadDestination, decryptPreview, decryptThumbnail, downloadDecryptedFile, downloadName } from "@/lib/files/decrypt-client";
import { announceFileDeleting, onFileDeleting } from "@/lib/files/deletion-events";
import { onFileReady } from "@/lib/files/ready-events";
import { useVaultKeyStatus } from "@/hooks/use-vault-key-status";
import type { FileAccessMetadata, FilePublicMetadata } from "@/types/files";

type Media = FilePublicMetadata & { name: string };
type GalleryPage = { media: (FilePublicMetadata & { cursor: string })[]; nextCursor: string | null };
type State = { status: "loading" | "ready" | "error"; files: Media[]; next: string | null };

async function accessFor(file: Media, signal: AbortSignal): Promise<FileAccessMetadata> {
  const response = await fetch(`/api/files/${file.id}`, { credentials: "same-origin", cache: "no-store", signal });
  if (response.status === 401) { clearVaultKeyMaterial(); window.location.replace("/unlock"); throw new Error("locked"); }
  if (!response.ok) throw new Error("unavailable");
  const data = await response.json() as { file: FileAccessMetadata };
  if (data.file.id !== file.id || data.file.category !== file.category || data.file.storedSizeBytes !== file.storedSizeBytes) {
    throw new Error("invalid_file");
  }
  return data.file;
}

function PreviewCard({ file, onOpen, onDownload, onDelete }: { file: Media;
  onOpen: () => void; onDownload: () => void; onDelete: () => void }) {
  const element = useRef<HTMLLIElement>(null);
  const [visible, setVisible] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!file.hasThumbnail || !element.current) return;
    if (typeof IntersectionObserver === "undefined") { queueMicrotask(() => setVisible(true)); return; }
    const observer = new IntersectionObserver((entries) => {
      const inView = entries.some((entry) => entry.isIntersecting);
      setVisible(inView);
      if (!inView) setUrl(null);
    },
      { rootMargin: "120px" });
    observer.observe(element.current);
    return () => observer.disconnect();
  }, [file.hasThumbnail]);
  useEffect(() => {
    if (!visible || !hasVaultRootKey()) return;
    const controller = new AbortController();
    let objectUrl: string | undefined;
    void (async () => {
      const metadata = await accessFor(file, controller.signal);
      if (!metadata.thumbnail) return;
      const blob = await decryptThumbnail(file.id, metadata.thumbnail.storedSizeBytes,
        metadata.thumbnail.encryptionManifest, controller.signal);
      if (controller.signal.aborted || !hasVaultRootKey()) return;
      objectUrl = URL.createObjectURL(blob); setUrl(objectUrl);
    })().catch(() => undefined);
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [visible, file]);
  return <li ref={element} className="min-w-0 overflow-hidden rounded-2xl border border-line bg-surface shadow-sm">
    <button type="button" onClick={onOpen} aria-label={`Open ${file.name}`}
      className="relative flex aspect-[4/3] w-full items-center justify-center overflow-hidden bg-raised text-muted focus-visible:outline-2 focus-visible:outline-offset-[-3px] focus-visible:outline-accent">
      {/* Local decrypted object URLs must never enter a remote image optimizer. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {url ? <img src={url} alt="" className="size-full object-cover" loading="lazy" />
        : file.category === "image" ? <ImageIcon size={34} aria-hidden="true" /> : <Video size={34} aria-hidden="true" />}
      {file.category === "video" && <span className="absolute bottom-2 left-2 rounded-full bg-black/75 px-2 py-1 text-xs text-white">Video</span>}
    </button>
    <div className="space-y-3 p-3 sm:p-4">
      <p className="truncate text-sm font-medium" title={file.name}>{file.name}</p>
      <p className="text-xs text-muted">{new Date(file.createdAt).toLocaleDateString()} · {(file.storedSizeBytes / 1_000_000).toFixed(2)} MB</p>
      <div className="flex gap-2">
        <Button type="button" size="small" variant="secondary" onClick={onDownload} aria-label={`Download ${file.name}`}><Download size={16} />Download</Button>
        <Button type="button" size="small" variant="ghost" onClick={onDelete} aria-label={`Delete ${file.name}`}><Trash2 size={16} />Delete</Button>
      </div>
    </div>
  </li>;
}

export function SimpleGallery() {
  const unlocked = useVaultKeyStatus();
  const [state, setState] = useState<State>({ status: "loading", files: [], next: null });
  const [selected, setSelected] = useState<Media | null>(null);
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const [photoError, setPhotoError] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Media | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const loadController = useRef<AbortController | null>(null);
  const viewController = useRef<AbortController | null>(null);
  const actionController = useRef<AbortController | null>(null);
  const photoUrlRef = useRef<string | null>(null);
  const generation = useRef(0);

  const closeViewer = useCallback(() => {
    viewController.current?.abort(); viewController.current = null;
    actionController.current?.abort(); actionController.current = null;
    setSelected(null); setPhotoError(false);
    if (photoUrlRef.current) URL.revokeObjectURL(photoUrlRef.current);
    photoUrlRef.current = null; setPhotoUrl(null);
  }, []);

  const load = useCallback(async (after?: string) => {
    if (!hasVaultRootKey()) return;
    const sequence = ++generation.current;
    loadController.current?.abort();
    const controller = new AbortController(); loadController.current = controller;
    setState((current) => ({ ...current, status: "loading" }));
    try {
      const query = new URLSearchParams({ category: "all", sort: "newest" });
      if (after) query.set("after", after);
      const response = await fetch(`/api/vault/gallery?${query}`, { credentials: "same-origin", cache: "no-store", signal: controller.signal });
      if (response.status === 401) { clearVaultKeyMaterial(); window.location.replace("/unlock"); return; }
      if (!response.ok) throw new Error("unavailable");
      const page = await response.json() as GalleryPage;
      const files = await Promise.all(page.media.map(async (file) => ({ ...file, name: await decryptFileName(file.id, file.nameEncrypted) })));
      if (sequence === generation.current && !controller.signal.aborted && hasVaultRootKey()) {
        setState((current) => ({ status: "ready", files: after ? [...current.files, ...files] : files, next: page.nextCursor }));
      }
    } catch {
      if (sequence === generation.current && !controller.signal.aborted && hasVaultRootKey()) {
        setState((current) => ({ ...current, status: "error" }));
      }
    }
  }, []);

  useEffect(() => {
    const sequenceRef = generation;
    const refresh = () => { closeViewer(); void load(); };
    const clear = () => { generation.current++; loadController.current?.abort(); closeViewer(); setState({ status: "loading", files: [], next: null }); setDeleteTarget(null); setNotice(""); };
    window.addEventListener("vaultx:key-clear", clear);
    window.addEventListener("vaultx:key-ready", refresh);
    const stopReady = onFileReady(refresh);
    const stopDeleting = onFileDeleting(refresh);
    if (hasVaultRootKey()) queueMicrotask(refresh);
    return () => { sequenceRef.current++; loadController.current?.abort(); viewController.current?.abort();
      if (photoUrlRef.current) URL.revokeObjectURL(photoUrlRef.current);
      actionController.current?.abort(); stopReady(); stopDeleting(); window.removeEventListener("vaultx:key-clear", clear);
      window.removeEventListener("vaultx:key-ready", refresh); };
  }, [closeViewer, load]);

  async function open(file: Media) {
    closeViewer(); setSelected(file);
    if (file.category !== "image") return;
    const controller = new AbortController(); viewController.current = controller;
    try {
      const metadata = await accessFor(file, controller.signal);
      if (metadata.storedSizeBytes >= 1_000_000) throw new Error("invalid_photo");
      const result = await decryptPreview(file.id, metadata.storedSizeBytes, metadata.encryptionManifest,
        { extension: file.extension, mimeType: file.mimeType }, "image", controller.signal);
      if (controller.signal.aborted || !hasVaultRootKey()) return;
      photoUrlRef.current = URL.createObjectURL(result.blob); setPhotoUrl(photoUrlRef.current);
    } catch { if (!controller.signal.aborted && hasVaultRootKey()) setPhotoError(true); }
  }

  async function download(file: Media) {
    if (!hasVaultRootKey() || busy) return;
    const controller = new AbortController(); actionController.current = controller;
    setBusy(true); setNotice("Preparing your download…");
    try {
      const destination = await chooseDownloadDestination(downloadName(file.name, file.extension), file.mimeType, file.extension);
      const metadata = await accessFor(file, controller.signal);
      await downloadDecryptedFile(file.id, metadata.storedSizeBytes, metadata.encryptionManifest,
        { extension: file.extension, mimeType: file.mimeType }, controller.signal, destination, file.name);
      if (!controller.signal.aborted) setNotice("Download ready.");
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") { if (hasVaultRootKey()) setNotice(""); }
      else if (!controller.signal.aborted) {
        setNotice("Download failed. Keep this page open and try again.");
      }
    } finally { setBusy(false); actionController.current = null; }
  }

  async function remove() {
    if (!deleteTarget || busy) return;
    setBusy(true); setNotice("");
    try {
      const response = await fetch(`/api/files/${deleteTarget.id}`, { method: "DELETE", credentials: "same-origin", cache: "no-store" });
      if (response.status === 401) { clearVaultKeyMaterial(); window.location.replace("/unlock"); return; }
      if (!response.ok) throw new Error("unavailable");
      const data = await response.json() as { deletion: { status: string } };
      setDeleteTarget(null); closeViewer(); announceFileDeleting(deleteTarget.id);
      setNotice(data.deletion.status === "completed" ? "Deleted from active storage and database."
        : "Deletion is pending verification. Open Deletions to see progress or retry.");
      void load();
    } catch { setNotice("Deletion could not be confirmed. Open Deletions to check its status."); }
    finally { setBusy(false); }
  }

  return <div className="space-y-6">
    <div className="flex flex-wrap items-center justify-between gap-4">
      <div><h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">My gallery</h1>
        <p className="mt-2 text-sm text-muted">Private photos and videos. Downloads contain the version stored here.</p></div>
      {unlocked && <Button type="button" onClick={() => window.dispatchEvent(new Event("vaultx:open-upload-picker"))}>
        <Plus size={18} aria-hidden="true" />Upload photos or videos</Button>}
    </div>
    {!unlocked ? <div><p className="text-sm text-muted">Unlock your encryption key once to view and upload media.</p><VaultKeySettings /></div> : <>
      <UploadManager compact />
      {notice && <p role="status" className="rounded-xl border border-line bg-surface p-3 text-sm">{notice}{notice.includes("Deletion") && <Link href="/vault/deletions" className="ml-2 text-accent underline">Deletions</Link>}</p>}
      {state.status === "loading" && <div role="status" aria-label="Loading gallery" className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {Array.from({ length: 8 }, (_, index) => <Skeleton key={index} className="aspect-[4/3] rounded-2xl" />)}</div>}
      {state.status === "error" && <EmptyState icon={<ImageIcon size={24} />} title="Gallery unavailable"
        description="Check the connection and try again." action={<Button onClick={() => void load()}>Retry</Button>} />}
      {state.status === "ready" && (state.files.length ? <>
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {state.files.map((file) => <PreviewCard key={file.id} file={file} onOpen={() => void open(file)}
            onDownload={() => void download(file)} onDelete={() => setDeleteTarget(file)} />)}
        </ul>
        {state.next && <div className="text-center"><Button variant="secondary" onClick={() => void load(state.next!)}>Load more</Button></div>}
      </> : <EmptyState icon={<ImageIcon size={24} />} title="No photos or videos yet"
        description="Use Upload photos or videos to choose files from your device." />)}
    </>}

    <Dialog open={selected !== null} onOpenChange={(open) => { if (!open) closeViewer(); }}>
      <DialogContent className="max-w-4xl"><DialogTitle>{selected?.name ?? "Media"}</DialogTitle>
        <DialogDescription>{selected?.category === "video" ? "This encrypted video is download only." : "Private photo"}</DialogDescription>
        {/* Local decrypted object URL; never send it through an image optimizer. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {selected?.category === "image" && (photoUrl ? <img src={photoUrl} alt={selected.name} className="max-h-[65vh] w-full object-contain" />
          : <p className="p-8 text-center text-sm text-muted">{photoError ? "Photo could not be opened." : "Decrypting photo…"}</p>)}
        {selected?.category === "video" && <div className="flex min-h-40 items-center justify-center rounded-xl bg-raised"><Video size={38} aria-hidden="true" /></div>}
        {selected && <div className="flex flex-wrap gap-2"><Button variant="secondary" disabled={busy} onClick={() => void download(selected)}><Download size={16} />Download</Button>
          <Button variant="danger" onClick={() => { setDeleteTarget(selected); closeViewer(); }}><Trash2 size={16} />Delete</Button></div>}
      </DialogContent>
    </Dialog>
    <Dialog open={deleteTarget !== null} onOpenChange={(open) => { if (!open && !busy) setDeleteTarget(null); }}>
      <DialogContent><DialogTitle>Delete this file?</DialogTitle>
        <DialogDescription>{deleteTarget?.name} will be removed from active Cloudinary storage and MongoDB. The file disappears from the gallery while deletion is pending.</DialogDescription>
        <div className="mt-5 flex justify-end gap-2"><Button variant="secondary" disabled={busy} onClick={() => setDeleteTarget(null)}>Cancel</Button>
          <Button variant="danger" disabled={busy} onClick={() => void remove()}>{busy ? "Deleting…" : "Delete permanently"}</Button></div>
      </DialogContent>
    </Dialog>
  </div>;
}

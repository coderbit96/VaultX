"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Download, Eye, LockKeyhole, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { FileIcon } from "@/components/ui/file-icon";
import { Skeleton } from "@/components/ui/skeleton";
import { FileOrganize } from "@/components/vault/file-organize";
import { FileDelete } from "@/components/vault/file-delete";
import { OfflineFileControl } from "@/components/vault/offline-file-control";
import { decryptFileName } from "@/lib/crypto/file-names";
import { clearVaultKeyMaterial, hasVaultRootKey } from "@/lib/crypto/key-memory";
import { chooseDownloadDestination, decryptPreview, downloadDecryptedFile, downloadName, previewKind, textFromBlob, type PreviewKind } from "@/lib/files/decrypt-client";
import type { FileAccessMetadata } from "@/lib/files/types";
import { onFileDeleting } from "@/lib/files/deletion-events";

type View = { status: "locked" | "loading" | "ready" | "error" | "deleting"; file?: FileAccessMetadata & { name: string } };
type Preview = { kind: PreviewKind; url?: string; text?: string };

export function FileDetails({ id }: { id: string }) {
  const [view, setView] = useState<View>({ status: "locked" });
  const request = useRef<AbortController | null>(null);
  const action = useRef<AbortController | null>(null);
  const objectUrl = useRef<string | null>(null);
  const epoch = useRef(0);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [actionState, setActionState] = useState<"idle" | "previewing" | "downloading" | "error">("idle");
  const [actionError, setActionError] = useState("");
  const clearPreview = useCallback(() => {
    action.current?.abort(); action.current = null;
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    objectUrl.current = null; setPreview(null); setActionState("idle"); setActionError("");
  }, []);
  const load = useCallback(async () => {
    if (!hasVaultRootKey()) { setView({ status: "locked" }); return; }
    const started = ++epoch.current;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setView({ status: "loading" });
    try {
      const response = await fetch(`/api/files/${id}`, { credentials: "same-origin", cache: "no-store", signal: controller.signal });
      if (response.status === 401) { clearVaultKeyMaterial(); window.location.replace("/unlock"); return; }
      if (!response.ok) throw new Error("load_failed");
      const data = await response.json() as { file: FileAccessMetadata };
      const name = await decryptFileName(data.file.id, data.file.nameEncrypted);
      if (started === epoch.current && hasVaultRootKey()) setView({ status: "ready", file: { ...data.file, name } });
    } catch {
      if (started === epoch.current && !controller.signal.aborted && hasVaultRootKey()) setView({ status: "error" });
    }
  }, [id]);
  useEffect(() => {
    const clear = () => { epoch.current++; request.current?.abort(); clearPreview(); setView({ status: "locked" }); };
    const ready = () => { void load(); };
    window.addEventListener("vaultx:key-clear", clear);
    window.addEventListener("vaultx:key-ready", ready);
    const stopDeletion = onFileDeleting((fileId) => { if (fileId === id || fileId === "*") {
      epoch.current++; request.current?.abort(); clearPreview(); setView({ status: "deleting" });
    } });
    let mounted = true;
    queueMicrotask(() => { if (mounted && hasVaultRootKey()) void load(); });
    return () => { mounted = false; request.current?.abort(); action.current?.abort(); if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
      stopDeletion(); window.removeEventListener("vaultx:key-clear", clear); window.removeEventListener("vaultx:key-ready", ready); };
  }, [clearPreview, load, id]);
  async function showPreview() {
    const target = view.file;
    if (!target || !hasVaultRootKey()) return;
    clearPreview(); const controller = new AbortController(); action.current = controller;
    const kind = previewKind(target.mimeType, target.extension);
    setActionState("previewing");
    try {
      const result = await decryptPreview(target.id, target.storedSizeBytes, target.encryptionManifest,
        { extension: target.extension, mimeType: target.mimeType }, kind, controller.signal);
      if (controller.signal.aborted || !hasVaultRootKey()) return;
      if (kind === "text") setPreview({ kind, text: await textFromBlob(result.blob) });
      else { const url = URL.createObjectURL(result.blob); objectUrl.current = url; setPreview({ kind, url }); }
      setActionState("idle");
    } catch (error) {
      if (!controller.signal.aborted) { setActionState("error"); setActionError(error instanceof Error ? error.message : "Preview failed."); }
    }
  }
  async function download() {
    const target = view.file;
    if (!target || !hasVaultRootKey()) return;
    action.current?.abort(); const controller = new AbortController(); action.current = controller;
    setActionState("downloading"); setActionError("");
    try {
      // Must happen within the click call stack: Chromium otherwise removes the
      // user activation before we finish authenticated network/decryption work.
      const destination = await chooseDownloadDestination(downloadName(target.name, target.extension), target.mimeType, target.extension);
      await downloadDecryptedFile(target.id, target.storedSizeBytes, target.encryptionManifest,
        { extension: target.extension, mimeType: target.mimeType }, controller.signal, destination, target.name);
      if (!controller.signal.aborted) setActionState("idle");
    } catch (error) {
      if (!controller.signal.aborted) { setActionState("error"); setActionError(error instanceof Error ? error.message : "Download failed."); }
    }
  }
  const file = view.file;
  return <div className="space-y-7">
    <div><p className="text-xs font-semibold uppercase tracking-[0.2em] text-accent">Private library / File</p>
      <h1 className="mt-2 break-words text-3xl font-semibold tracking-tight sm:text-4xl">{file?.name ?? "File details"}</h1>
      <p className="mt-3 text-sm text-muted">Files decrypt only in this unlocked browser. Downloads use the stored optimized format, never the original source.</p></div>
    {view.status === "locked" && <EmptyState icon={<LockKeyhole size={24} />} title="Vault key locked"
      description="Unlock your vault key in Settings to decrypt the filename on this device."
      action={<Link href="/vault/settings" className="inline-flex min-h-11 items-center rounded-xl bg-accent px-5 text-sm font-medium text-accent-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">Open Settings</Link>} />}
    {view.status === "loading" && <Skeleton className="h-52 rounded-2xl" />}
    {view.status === "error" && <EmptyState icon={<LockKeyhole size={24} />} title="File details could not be opened"
      description="Check your connection and vault key, then try again."
      action={<Button type="button" onClick={() => void load()}>Try again</Button>} />}
    {view.status === "deleting" && <EmptyState icon={<LockKeyhole size={24} />} title="Deletion is in progress"
      description="The file is hidden. Open Deletions for verified Cloudinary and MongoDB status."
      action={<Link href="/vault/deletions" className="inline-flex min-h-11 items-center rounded-xl bg-accent px-5 text-sm font-medium text-accent-ink">View deletions</Link>} />}
    {view.status === "ready" && file && <div className="rounded-2xl border border-line bg-surface p-5 sm:p-7">
      <div className="flex min-w-0 items-center gap-4"><FileIcon category={file.category} />
        <div className="min-w-0"><p className="truncate font-medium">{file.name}</p><p className="mt-1 text-xs text-muted">{file.category}</p></div></div>
      <dl className="mt-6 grid gap-5 border-t border-line pt-6 text-sm sm:grid-cols-2">
        <div><dt className="text-muted">Stored format</dt><dd className="mt-1">{file.extension || "None"} · {file.mimeType}</dd></div>
        <div><dt className="text-muted">Stored ciphertext size</dt><dd className="mt-1">{file.storedSizeBytes.toLocaleString()} bytes</dd></div>
        {file.width && file.height && <div><dt className="text-muted">Output dimensions</dt><dd className="mt-1">{file.width} × {file.height}</dd></div>}
        {file.durationSeconds && <div><dt className="text-muted">Output duration</dt><dd className="mt-1">{file.durationSeconds.toLocaleString()} seconds</dd></div>}
        <div><dt className="text-muted">Added</dt><dd className="mt-1">{new Date(file.createdAt).toLocaleString()}</dd></div>
      </dl>
      <div className="mt-6 flex flex-wrap gap-3">
        {previewKind(file.mimeType, file.extension) !== "none" && <Button type="button" onClick={() => void showPreview()} disabled={actionState === "previewing" || actionState === "downloading"}>
          <Eye aria-hidden="true" size={17} />{actionState === "previewing" ? "Decrypting preview…" : "Preview"}
        </Button>}
        <Button type="button" variant="secondary" onClick={() => void download()} disabled={actionState === "previewing" || actionState === "downloading"}>
          <Download aria-hidden="true" size={17} />{actionState === "downloading" ? "Decrypting download…" : `Download .${file.extension}`}
        </Button>
      </div>
      <div className="mt-3 flex flex-wrap gap-3"><FileOrganize id={file.id} name={file.name} extension={file.extension} onSaved={() => void load()} /></div>
      <OfflineFileControl file={file} />
      <div className="mt-6 border-t border-line pt-6"><FileDelete id={file.id} name={file.name} onQueued={() => clearPreview()} /></div>
      {actionState === "error" && <p role="alert" className="mt-4 rounded-xl border border-red-400/30 bg-red-400/10 p-3 text-sm text-red-100">{actionError}</p>}
      {preview && <section className="mt-6 rounded-2xl border border-line bg-canvas p-4" aria-label="Decrypted preview">
        <div className="mb-3 flex items-center justify-between gap-3"><p className="text-sm font-medium">Private local preview</p><Button type="button" variant="ghost" size="small" onClick={clearPreview}><X aria-hidden="true" size={16} />Close</Button></div>
        {preview.kind === "image" && preview.url && <>{/* Blob URLs must stay client-local; do not route plaintext through image optimization. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={preview.url} alt="Decrypted image preview" className="max-h-[70vh] max-w-full rounded-xl" />
        </>}
        {preview.kind === "audio" && preview.url && <audio controls preload="metadata" src={preview.url} className="w-full" aria-label="Decrypted audio player" />}
        {preview.kind === "pdf" && preview.url && <iframe src={preview.url} title="Decrypted PDF preview" sandbox="" className="h-[70vh] w-full rounded-xl border border-line bg-white" />}
        {preview.kind === "text" && <pre className="max-h-[70vh] overflow-auto whitespace-pre-wrap break-words rounded-xl bg-surface p-4 text-sm text-foreground">{preview.text}</pre>}
      </section>}
    </div>}
    <Link href={file?.folderId ? `/vault/folders/${file.folderId}` : "/vault/files"} className="inline-flex min-h-11 items-center rounded-lg text-sm text-accent hover:underline focus-visible:outline-2 focus-visible:outline-accent">Back to files</Link>
  </div>;
}

"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { FileUp, LockKeyhole, RotateCcw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { hasVaultRootKey } from "@/lib/crypto/key-memory";
import type { MediaCategory, MetadataInput, PreparedContainer } from "@/lib/crypto/file-container";
import type { CompletionMetadata } from "@/lib/uploads/lifecycle";
import { announceFileReady } from "@/lib/files/ready-events";
import { dedupeSelection, selectionKey } from "@/lib/uploads/selection";

type Stage = "queued" | "optimizing" | "review" | "encrypting" | "uploading" | "verifying" | "ready" | "failed" | "cancelled";
type Entry = { key: string; label: string; stage: Stage; progress?: number; detail?: string;
  jobId?: string; fileId?: string; storedBytes?: number; storedName?: string; metadata?: CompletionMetadata;
  previewUrl?: string; thumbnailUrl?: string; previewCategory?: "image" | "video" };
type Saved = { jobId: string; fileId: string; metadata: CompletionMetadata; storedBytes: number };
const STORAGE = "vaultx:pending-uploads:v1";
const ACCOUNT_LIMIT = 10_000_000;

function readSaved(): Saved[] {
  try {
    const raw = JSON.parse(sessionStorage.getItem(STORAGE) ?? "[]") as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.filter((item): item is Saved => !!item && typeof item === "object"
      && /^[a-f0-9]{24}$/.test((item as Saved).jobId)
      && /^[a-f0-9]{24}$/.test((item as Saved).fileId)
      && !!(item as Saved).metadata && Number.isSafeInteger((item as Saved).storedBytes)).slice(0, 20);
  } catch { return []; }
}
function save(item: Saved) {
  sessionStorage.setItem(STORAGE, JSON.stringify([...readSaved().filter((value) => value.jobId !== item.jobId), item]));
}
function forget(jobId: string) {
  sessionStorage.setItem(STORAGE, JSON.stringify(readSaved().filter((item) => item.jobId !== jobId)));
}
function errorText(error: unknown): string {
  if (!navigator.onLine) return "Connection lost. Reconnect, then retry or cancel this upload.";
  if (error instanceof Error && error.name === "AbortError") return "Upload stopped. Cleanup may need a retry.";
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  if (code === "quality_floor") return "This file cannot fit the current Cloudinary limit at acceptable quality. Keep the original and try a shorter or smaller source.";
  if (code === "device_limit" || code === "encoder_unavailable") return "This device cannot process this video locally. Keep the original and try a supported desktop browser.";
  if (code === "unsupported" || code === "corrupt" || code === "unsupported_heic") return "This file could not be safely decoded or its format is unsupported. Nothing was uploaded.";
  if (code === "cancelled") return "Processing stopped. Nothing was marked ready.";
  if (error instanceof Error && error.message && !/unavailable|invalid_request|provider_mismatch/.test(error.message)) return error.message;
  return "Upload could not finish. Retry or cancel; it is not in your ready files.";
}
async function jsonApi<T>(path: string, method: string, body?: unknown): Promise<T> {
  const response = await fetch(path, { method, credentials: "same-origin", cache: "no-store",
    ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
  const data = await response.json().catch(() => null) as { error?: { code?: string } } | null;
  if (!response.ok) throw new Error(data?.error?.code === "rate_limited" ? "Too many upload attempts. Try again later."
    : data?.error?.code === "vault_setup_required" ? "Finish the one-time file setup and save your recovery key before uploading."
    : data?.error?.code === "upload_conflict" ? "Upload state changed. Refresh the page and try again."
      : "Upload service unavailable. Try again later.");
  return data as T;
}
function sendCiphertext(id: string, blob: Blob, signal: AbortSignal, onProgress: (percent: number) => void,
  onXhr: (xhr: XMLHttpRequest | null) => void, variant?: "thumbnail"): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest(); onXhr(xhr);
    const abort = () => xhr.abort();
    signal.addEventListener("abort", abort, { once: true });
    xhr.open("PUT", `/api/uploads/${id}/ciphertext${variant ? "?variant=thumbnail" : ""}`);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.upload.onprogress = (event) => { if (event.lengthComputable) onProgress(Math.min(99, Math.floor(event.loaded / event.total * 100))); };
    xhr.onload = () => { signal.removeEventListener("abort", abort); onXhr(null);
      if (xhr.status >= 200 && xhr.status < 300) resolve(); else reject(new Error("Ciphertext transfer failed. Retry or cancel.")); };
    xhr.onerror = () => { signal.removeEventListener("abort", abort); onXhr(null); reject(new Error("Network transfer failed.")); };
    xhr.onabort = () => { signal.removeEventListener("abort", abort); onXhr(null); reject(new DOMException("Aborted", "AbortError")); };
    if (signal.aborted) abort(); else xhr.send(blob);
  });
}

export function UploadManager({ compact = false }: { compact?: boolean }) {
  const picker = useRef<HTMLInputElement>(null);
  const files = useRef(new Map<string, File>());
  const controllers = useRef(new Map<string, AbortController>());
  const requests = useRef(new Map<string, XMLHttpRequest>());
  const approvals = useRef(new Map<string, { resolve: () => void; reject: () => void }>());
  const previews = useRef(new Map<string, string>());
  const videoThumbnails = useRef(new Map<string, string>());
  const selectedKeys = useRef(new Map<string, string>());
  const seenSelections = useRef(new Set<string>());
  const entries = useRef<Entry[]>([]);
  const queue = useRef<string[]>([]);
  const busy = useRef(false);
  const [items, setItems] = useState<Entry[]>([]);
  const [unlocked, setUnlocked] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [offline, setOffline] = useState(false);
  const [duplicateNotice, setDuplicateNotice] = useState("");

  function releaseSelection(key: string) {
    const signature = selectedKeys.current.get(key);
    if (signature) seenSelections.current.delete(signature);
    selectedKeys.current.delete(key);
  }

  function replace(key: string, patch: Partial<Entry>) {
    entries.current = entries.current.map((item) => item.key === key ? { ...item, ...patch } : item);
    setItems(entries.current);
  }

  async function restore() {
    for (const saved of readSaved()) {
      const key = saved.jobId;
      if (entries.current.some((item) => item.key === key)) continue;
      const entry: Entry = { key, jobId: key, fileId: saved.fileId, metadata: saved.metadata,
        label: "Previous upload", stage: "verifying", storedBytes: saved.storedBytes };
      entries.current = [...entries.current, entry]; setItems(entries.current);
      try {
        const { upload } = await jsonApi<{ upload: { status: string; transferComplete: boolean } }>(`/api/uploads/${key}`, "GET");
        if (upload.status === "completed") { forget(key); replace(key, { stage: "ready", detail: "Stored and verified." }); announceFileReady(saved.fileId); }
        else if (upload.status === "cancelled") { forget(key); replace(key, { stage: "cancelled", detail: "Cleanup confirmed." }); }
        else if (upload.transferComplete && hasVaultRootKey()) await finish(entry);
        else replace(key, { stage: "failed", detail: "Select the source again to retry, or cancel this unfinished upload." });
      } catch { replace(key, { stage: "failed", detail: "Could not check this upload. Retry later or cancel it." }); }
    }
  }

  async function finish(entry: Entry) {
    if (!entry.jobId || !entry.metadata) throw new Error("Missing encrypted upload metadata.");
    replace(entry.key, { stage: "verifying", detail: "Checking Cloudinary object and stored ciphertext bytes." });
    const { upload } = await jsonApi<{ upload: { status: string } }>("/api/uploads/complete", "POST",
      { id: entry.jobId, ...entry.metadata });
    if (upload.status !== "completed") throw new Error("Upload verification is still pending.");
    forget(entry.jobId);
    replace(entry.key, { stage: "ready", progress: 100, detail: "Stored ciphertext verified. Original was not retained." });
    if (entry.fileId) announceFileReady(entry.fileId);
  }

  useEffect(() => {
    const activeControllers = controllers.current, activeRequests = requests.current;
    const activeApprovals = approvals.current, activePreviews = previews.current, activeVideoThumbnails = videoThumbnails.current;
    const lock = () => {
      activeControllers.forEach((controller) => controller.abort()); activeRequests.forEach((xhr) => xhr.abort());
      activeApprovals.forEach((approval) => approval.reject()); activeApprovals.clear();
      activePreviews.forEach((url) => URL.revokeObjectURL(url)); activePreviews.clear();
      activeVideoThumbnails.forEach((url) => URL.revokeObjectURL(url)); activeVideoThumbnails.clear();
      files.current.clear(); selectedKeys.current.clear(); seenSelections.current.clear(); queue.current = []; entries.current = []; setItems([]); setUnlocked(false); setDuplicateNotice("");
    };
    const ready = () => { setUnlocked(true); void restore(); };
    const disconnected = () => { setOffline(true); activeControllers.forEach((controller) => controller.abort()); };
    const connected = () => { setOffline(false); void drain(); };
    window.addEventListener("vaultx:key-clear", lock); window.addEventListener("vaultx:key-ready", ready);
    const openPicker = () => picker.current?.click();
    window.addEventListener("vaultx:open-upload-picker", openPicker);
    window.addEventListener("offline", disconnected); window.addEventListener("online", connected);
    queueMicrotask(() => { setOffline(!navigator.onLine); if (hasVaultRootKey()) ready(); });
    return () => { activeControllers.forEach((controller) => controller.abort()); activeRequests.forEach((xhr) => xhr.abort());
      activeApprovals.forEach((approval) => approval.reject()); activePreviews.forEach((url) => URL.revokeObjectURL(url));
      activeVideoThumbnails.forEach((url) => URL.revokeObjectURL(url));
      window.removeEventListener("vaultx:key-clear", lock); window.removeEventListener("vaultx:key-ready", ready);
      window.removeEventListener("vaultx:open-upload-picker", openPicker);
      window.removeEventListener("offline", disconnected); window.removeEventListener("online", connected); };
    // Restore once per key-ready event; state is owned by this mounted manager.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function process(key: string) {
    const file = files.current.get(key);
    if (!file || !hasVaultRootKey()) return;
    const controller = new AbortController(); controllers.current.set(key, controller);
    let prepared: PreparedContainer | undefined;
    let preparedThumbnail: PreparedContainer | undefined;
    let thumbnailBlob: Blob | undefined;
    let reservedId: string | undefined;
    try {
      replace(key, { stage: "optimizing", detail: "Inspecting on this device." });
      let blob: Blob = file;
      let metadata: MetadataInput;
      let category: MediaCategory;
      let media: Pick<CompletionMetadata, "width" | "height" | "durationSeconds"> = {};
      const name = file.name.toLowerCase();
      if (/^image\//.test(file.type) || /\.(?:jpe?g|png|webp|gif|heic|heif)$/.test(name)) {
        const { optimizeImage } = await import("@/lib/image/optimize-image");
        const result = await optimizeImage(file, { signal: controller.signal,
          onProgress: (message) => replace(key, { detail: message }) });
        blob = result.blob; metadata = result.metadata; category = "image";
        media = { width: result.width, height: result.height };
      } else if (/^video\//.test(file.type) || /\.(?:mp4|mov|webm)$/.test(name)) {
        const { optimizeVideo } = await import("@/lib/video/optimize-video");
        const result = await optimizeVideo(file, { signal: controller.signal, uploadMaxObjectBytes: ACCOUNT_LIMIT,
          onProgress: (progress) => replace(key, { detail: progress.stage === "transcoding"
            ? `Transcoding locally: ${progress.percent ?? 0}%` : `Local video ${progress.stage}.`, progress: progress.percent }) });
        blob = result.blob; metadata = result.metadata; category = "video";
        media = { width: result.output.width, height: result.output.height, durationSeconds: result.output.durationSeconds };
      } else {
        const { classifyOtherFile } = await import("@/lib/uploads/local-file");
        const decision = await classifyOtherFile(file);
        metadata = decision.metadata; category = decision.category;
      }
      const nameStem = metadata.storedName.replace(/\.[^.]+$/, "");
      metadata = { ...metadata, storedName: metadata.extension
        ? `${[...nameStem].slice(0, 119 - metadata.extension.length).join("")}.${metadata.extension}`
        : [...metadata.storedName].slice(0, 120).join("") };
      if (controller.signal.aborted || !hasVaultRootKey()) throw new DOMException("Aborted", "AbortError");
      if (category === "image" || category === "video") {
        const { createLocalThumbnail, createLocalVideoThumbnail } = await import("@/lib/gallery/thumbnail");
        thumbnailBlob = category === "image" ? (await createLocalThumbnail(blob, controller.signal)).blob
          : await createLocalVideoThumbnail(blob, controller.signal);
        if (thumbnailBlob.size > 850_000) throw new Error("This preview is too large to store safely.");
        if (!compact) {
        const previewUrl = URL.createObjectURL(blob);
        previews.current.set(key, previewUrl);
        let thumbnailUrl: string | undefined;
        if (category === "video") {
          thumbnailUrl = URL.createObjectURL(thumbnailBlob);
          videoThumbnails.current.set(key, thumbnailUrl);
        }
        if (controller.signal.aborted || !hasVaultRootKey()) throw new DOMException("Aborted", "AbortError");
        replace(key, { stage: "review", storedName: metadata.storedName, previewUrl, thumbnailUrl, previewCategory: category,
          progress: undefined, detail: `${metadata.mimeType} · ${blob.size.toLocaleString()} optimized bytes. Review the local result before uploading.` });
        await new Promise<void>((resolve, reject) => approvals.current.set(key, { resolve, reject }));
        approvals.current.delete(key); URL.revokeObjectURL(previewUrl); previews.current.delete(key);
        if (thumbnailUrl) { URL.revokeObjectURL(thumbnailUrl); videoThumbnails.current.delete(key); }
        replace(key, { previewUrl: undefined, thumbnailUrl: undefined, previewCategory: undefined });
        }
      }
      if (controller.signal.aborted || !hasVaultRootKey()) throw new DOMException("Aborted", "AbortError");
      replace(key, { stage: "encrypting", progress: 0, storedName: metadata.storedName,
        detail: "Encrypting locally. Only ciphertext will leave this device." });
      const { prepareEncryptedFile } = await import("@/lib/crypto/file-container");
      prepared = await prepareEncryptedFile(blob, metadata, category, controller.signal);
      if (thumbnailBlob) {
        const { prepareEncryptedThumbnail } = await import("@/lib/crypto/file-container");
        preparedThumbnail = await prepareEncryptedThumbnail(thumbnailBlob,
          { storedName: "preview.webp", extension: "webp", mimeType: "image/webp" }, prepared.manifest, controller.signal);
      }
      const expected = Number(prepared.manifest.objectBytes);
      if (expected >= ACCOUNT_LIMIT) { prepared.dispose(); throw new Error("This encrypted output exceeds the current Cloudinary plan limit."); }
      const { upload } = await jsonApi<{ upload: { id: string; fileId: string; transferAvailable: boolean } }>("/api/uploads/init", "POST",
        { category, folderId: null, manifest: prepared.manifest,
          ...(preparedThumbnail ? { thumbnailManifest: preparedThumbnail.manifest } : {}) });
      reservedId = upload.id;
      replace(key, { jobId: upload.id, fileId: upload.fileId });
      if (!upload.transferAvailable) { prepared.dispose(); throw new Error("Ciphertext transfer is unavailable for this file size."); }
      const { encryptFileName } = await import("@/lib/crypto/file-names");
      const nameEncrypted = await encryptFileName(upload.fileId, metadata.storedName);
      const originalName = [...file.name.normalize("NFC").replace(/[\\/\p{Cc}\p{Cf}]/gu, "").trim()].slice(0, 120).join("");
      const sourceNameEncrypted = await encryptFileName(upload.fileId, originalName || "file");
      const completion: CompletionMetadata = { nameEncrypted, sourceNameEncrypted,
        extension: metadata.extension, mimeType: metadata.mimeType, ...media };
      save({ jobId: upload.id, fileId: upload.fileId, metadata: completion, storedBytes: expected });
      replace(key, { jobId: upload.id, fileId: upload.fileId, metadata: completion, storedBytes: expected });
      const parts: ArrayBuffer[] = [];
      let count = 0;
      try {
        for await (const part of prepared.chunks()) {
          if (controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
          parts.push(Uint8Array.from(part).buffer);
          count += part.byteLength;
          replace(key, { progress: Math.floor(count / expected * 100) });
        }
      } finally { prepared.dispose(); }
      if (count !== expected) throw new Error("Encrypted byte count did not match the manifest.");
      const ciphertext = new Blob(parts, { type: "application/octet-stream" });
      replace(key, { stage: "uploading", progress: 0, detail: "Sending encrypted bytes to private storage." });
      await sendCiphertext(upload.id, ciphertext, controller.signal, (progress) => replace(key, { progress }),
        (xhr) => { if (xhr) requests.current.set(key, xhr); else requests.current.delete(key); });
      if (preparedThumbnail) {
        const thumbnailParts: ArrayBuffer[] = [];
        let thumbnailBytes = 0;
        const thumbnailExpected = Number(preparedThumbnail.manifest.objectBytes);
        try {
          for await (const part of preparedThumbnail.chunks()) {
            if (controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
            thumbnailParts.push(Uint8Array.from(part).buffer); thumbnailBytes += part.byteLength;
          }
        } finally { preparedThumbnail.dispose(); }
        if (thumbnailBytes !== thumbnailExpected) throw new Error("Encrypted preview byte count did not match.");
        replace(key, { stage: "uploading", progress: 0, detail: "Sending the private encrypted preview." });
        await sendCiphertext(upload.id, new Blob(thumbnailParts, { type: "application/octet-stream" }), controller.signal,
          (progress) => replace(key, { progress }),
          (xhr) => { if (xhr) requests.current.set(key, xhr); else requests.current.delete(key); }, "thumbnail");
      }
      if (controller.signal.aborted || !hasVaultRootKey()) throw new DOMException("Aborted", "AbortError");
      await finish({ ...entries.current.find((item) => item.key === key)!, metadata: completion, jobId: upload.id });
      files.current.delete(key);
    } catch (error) {
      if (reservedId && !readSaved().some((entry) => entry.jobId === reservedId)) {
        await jsonApi(`/api/uploads/${reservedId}`, "DELETE").catch(() => undefined);
      }
      if (hasVaultRootKey() && entries.current.find((item) => item.key === key)?.stage !== "cancelled") {
        replace(key, { stage: "failed", progress: undefined, detail: errorText(error) });
      }
    } finally { prepared?.dispose(); preparedThumbnail?.dispose(); controllers.current.delete(key); requests.current.delete(key);
      const preview = previews.current.get(key); if (preview) URL.revokeObjectURL(preview);
      previews.current.delete(key);
      const thumbnail = videoThumbnails.current.get(key); if (thumbnail) URL.revokeObjectURL(thumbnail);
      videoThumbnails.current.delete(key); approvals.current.delete(key); }
  }

  async function drain() {
    if (busy.current) return;
    busy.current = true;
    try { while (queue.current.length && hasVaultRootKey() && navigator.onLine) await process(queue.current.shift()!); }
    finally { busy.current = false; }
  }
  function add(list: FileList | File[]) {
    if (!hasVaultRootKey()) return;
    const selected = Array.from(list);
    const media = compact ? selected.filter((file) => /^(?:image|video)\//.test(file.type)
      || /\.(?:jpe?g|png|webp|gif|heic|heif|mp4|mov|webm)$/i.test(file.name)) : selected;
    const { accepted, skipped } = dedupeSelection(media, seenSelections.current);
    const notices = [];
    if (compact && media.length !== selected.length) notices.push("Choose photos or videos only.");
    if (skipped) notices.push(`${skipped} repeat selection${skipped === 1 ? " was" : "s were"} skipped in this tab. Choose the existing queue item to retry it.`);
    setDuplicateNotice(notices.join(" "));
    const next = accepted.map((file) => {
      const key = crypto.randomUUID(); files.current.set(key, file); selectedKeys.current.set(key, selectionKey(file)); queue.current.push(key);
      return { key, label: file.name, stage: "queued" as Stage, detail: "Waiting for local preparation." };
    });
    if (!next.length) return;
    entries.current = [...entries.current, ...next]; setItems(entries.current); void drain();
  }
  async function cancel(entry: Entry) {
    controllers.current.get(entry.key)?.abort(); requests.current.get(entry.key)?.abort();
    approvals.current.get(entry.key)?.reject(); approvals.current.delete(entry.key);
    queue.current = queue.current.filter((key) => key !== entry.key); files.current.delete(entry.key);
    if (!entry.jobId) { releaseSelection(entry.key); replace(entry.key, { stage: "cancelled", detail: "Cancelled before upload." }); return; }
    try {
      const { upload } = await jsonApi<{ upload: { status: string; cancelRequested: boolean } }>(`/api/uploads/${entry.jobId}`, "DELETE");
      if (upload.status === "cancelled") { forget(entry.jobId); releaseSelection(entry.key); replace(entry.key, { stage: "cancelled", detail: "Private object cleanup confirmed." }); }
      else replace(entry.key, { stage: "failed", detail: "Cancellation requested. Cleanup is pending; check again shortly." });
    } catch { replace(entry.key, { stage: "failed", detail: "Cleanup is pending. Retry cancellation when connected." }); }
  }
  async function retry(entry: Entry) {
    if (entry.jobId) {
      try {
        const { upload } = await jsonApi<{ upload: { transferComplete: boolean; status: string } }>(`/api/uploads/${entry.jobId}`, "GET");
        if (upload.status === "completed") { forget(entry.jobId); files.current.delete(entry.key);
          replace(entry.key, { stage: "ready", progress: 100, detail: "Stored ciphertext verified." });
          if (entry.fileId) announceFileReady(entry.fileId); return; }
        if (upload.transferComplete && entry.metadata) { await finish(entry); files.current.delete(entry.key); return; }
        if (upload.status !== "cancelled") {
          const result = await jsonApi<{ upload: { status: string } }>(`/api/uploads/${entry.jobId}`, "DELETE");
          if (result.upload.status !== "cancelled") {
            replace(entry.key, { stage: "failed", detail: "Old upload cleanup is still pending. Retry after it is confirmed; no new upload was started." });
            return;
          }
        }
        forget(entry.jobId);
      } catch (error) { replace(entry.key, { stage: "failed", detail: errorText(error) }); return; }
    }
    if (!files.current.has(entry.key)) { replace(entry.key, { stage: "failed", jobId: undefined,
      detail: "Choose the source file again below. Browsers do not retain file access after refresh." }); return; }
    replace(entry.key, { stage: "queued", progress: undefined, jobId: undefined, metadata: undefined });
    queue.current.push(entry.key); void drain();
  }

  return <div className="space-y-7">
    {!compact && <div><p className="text-xs font-semibold uppercase tracking-[0.2em] text-accent">Private library / Uploads</p>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">Upload to VaultX</h1>
      <p className="mt-3 max-w-2xl text-sm leading-6 text-muted">Choose photos or videos. They are optimized and encrypted on this device. Keep your own originals.</p></div>}
    {!compact && <div role="note" className="rounded-2xl border border-accent/25 bg-accent/5 p-4 text-sm leading-6 text-muted">
      This Cloudinary plan limits each private ciphertext object to under 10 MB. Images also stay under 1 MB. Longer videos may fail the local quality check. Downloads return only the optimized stored version, so keep a separate copy of each original.
    </div>}
    {offline && <p role="alert" className="rounded-xl border border-amber-400/30 p-3 text-sm text-amber-200">You are offline. In-progress transfers stopped; reconnect before retrying.</p>}
    {duplicateNotice && <p role="status" className="rounded-xl border border-line bg-surface p-3 text-sm text-muted">{duplicateNotice}</p>}
    {!unlocked ? compact ? null : <EmptyState icon={<LockKeyhole size={24} />} title="Vault key locked"
      description="Unlock the vault key in Settings before selecting files."
      action={<Link href="/vault/settings" className="inline-flex min-h-11 items-center rounded-xl bg-accent px-5 text-sm font-medium text-accent-ink">Open Settings</Link>} /> : <>
      <input ref={picker} type="file" accept={compact ? "image/*,video/*" : undefined} multiple className="sr-only" aria-label="Choose files to upload"
        onChange={(event) => { if (event.target.files) add(event.target.files); event.target.value = ""; }} />
      {!compact && <div onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
        onDragOver={(event) => event.preventDefault()} onDragLeave={() => setDragging(false)}
        onDrop={(event) => { event.preventDefault(); setDragging(false); add(event.dataTransfer.files); }}
        className={`rounded-2xl border-2 border-dashed p-8 text-center sm:p-12 ${dragging ? "border-accent bg-accent/10" : "border-line bg-surface"}`}>
        <FileUp aria-hidden="true" size={28} className="mx-auto text-accent" />
        <h2 className="mt-3 text-lg font-semibold">Choose files</h2>
        <p className="mt-1 text-sm text-muted">Tap to select on a phone, or drag files here on a desktop.</p>
        <Button className="mt-5" type="button" onClick={() => picker.current?.click()}>Select files</Button>
      </div>}
      {(items.length > 0 || !compact) && <section aria-label="Upload queue" className="space-y-3">
        {items.length === 0 ? <p className="rounded-2xl border border-line bg-surface p-6 text-sm text-muted">No files selected yet.</p> : items.map((item) =>
          <div key={item.key} className="rounded-2xl border border-line bg-surface p-4 sm:p-5">
            <div className="flex items-start justify-between gap-3"><div className="min-w-0"><h3 className="truncate font-medium">{item.storedName ?? item.label}</h3>
              <p className="mt-1 text-xs uppercase tracking-wide text-accent">{item.stage}{item.storedBytes ? ` · ${(item.storedBytes / 1_000_000).toFixed(2)} MB encrypted` : ""}</p></div>
              <div className="flex gap-1">{item.stage === "failed" && <Button type="button" variant="ghost" size="small" onClick={() => void retry(item)} aria-label={`Retry ${item.label}`}><RotateCcw size={16} /></Button>}
                {!(["ready", "cancelled"] as Stage[]).includes(item.stage) && <Button type="button" variant="ghost" size="small" onClick={() => void cancel(item)} aria-label={`Cancel ${item.label}`}><X size={16} /></Button>}</div></div>
            <p role={item.stage === "failed" ? "alert" : "status"} className="mt-2 text-sm text-muted">{item.detail}</p>
            {item.stage === "review" && item.previewUrl && <div className="mt-4 space-y-3">
              {item.previewCategory === "image" ? <div className="flex max-h-80 justify-center rounded-xl bg-black p-3">
                {/* Local object URL is revoked on approval, cancel, lock, and unmount. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={item.previewUrl} alt="Optimized local preview" className="max-h-72 max-w-full object-contain" />
              </div> : <div className="space-y-3">
                {item.thumbnailUrl && <div className="flex items-center gap-3 rounded-xl border border-line p-2">
                  {/* Temporary local frame URL; no provider transformation or plaintext cache. */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={item.thumbnailUrl} alt="Local video thumbnail" className="h-20 w-28 rounded-lg object-cover" />
                  <span className="text-xs text-muted">Private preview generated on this device.</span>
                </div>}
                <video src={item.previewUrl} controls playsInline preload="metadata" className="max-h-80 max-w-full rounded-xl bg-black" aria-label="Optimized local video preview" />
              </div>}
              <Button type="button" onClick={() => approvals.current.get(item.key)?.resolve()}>Encrypt and upload this result</Button>
            </div>}
            {item.stage === "failed" && !files.current.has(item.key) && <label className="mt-3 block text-sm text-accent">
              Select a file for a fresh attempt after old-job cleanup
              <input type="file" className="mt-2 block min-h-11 w-full text-sm text-foreground file:mr-3 file:rounded-lg file:border-0 file:bg-raised file:px-3 file:py-2 file:text-foreground"
                aria-label={`Select file to retry ${item.label}`} onChange={(event) => {
                  const file = event.target.files?.[0]; if (!file) return;
                  const signature = selectionKey(file);
                  if (seenSelections.current.has(signature)) { setDuplicateNotice("That file is already in this upload queue."); return; }
                  seenSelections.current.add(signature); selectedKeys.current.set(item.key, signature);
                  files.current.set(item.key, file); replace(item.key, { label: file.name });
                  void retry(item);
                }} />
            </label>}
            {item.progress !== undefined && !(["ready", "failed", "cancelled"] as Stage[]).includes(item.stage) &&
              <div className="mt-3"><progress value={item.progress} max={100} className="h-2 w-full accent-accent" aria-label={`${item.stage} progress`} />
                <span className="text-xs text-muted">{item.progress}%</span></div>}
          </div>)}
      </section>}
    </>}
  </div>;
}

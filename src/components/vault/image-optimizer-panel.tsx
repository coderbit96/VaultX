"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ImagePlus, LockKeyhole, ShieldCheck, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { hasVaultRootKey } from "@/lib/crypto/key-memory";
import { ImageOptimizationError } from "@/lib/image/image-policy";
import type { ImageOptimizationResult } from "@/lib/image/optimize-image";

type View = { status: "locked" | "idle" | "working" | "ready" | "error" | "cancelled"; message?: string;
  result?: ImageOptimizationResult; previewUrl?: string; sourceBytes?: number };

const messages: Record<ImageOptimizationError["code"], string> = {
  unsupported: "Choose a JPEG, PNG, WebP, still GIF, or a HEIC/HEIF image this browser can decode.",
  unsupported_heic: "This browser cannot decode this HEIC/HEIF image. Convert it on your device, then try again.",
  animated: "Animation detected. VaultX will not flatten it to a still image; animation-preserving optimization is not available yet.",
  corrupt: "This image could not be read. Choose an uncorrupted image and try again.",
  too_large: "This image is too large for safe processing on this device.",
  quality_floor: "This image cannot fit below the encrypted 1 MB limit while keeping the minimum quality and resolution. Choose another image or wait for an explicit lower-quality option.",
  cancelled: "Image preparation cancelled. Nothing was uploaded.",
  orientation: "The browser could not safely apply this image's orientation. Choose a converted image instead.",
  encoder: "This browser could not create a safe, metadata-free output. Try another browser or image.",
};

function size(bytes: number): string { return `${(bytes / 1_000_000).toFixed(2)} MB`; }

export function ImageOptimizerPanel() {
  const input = useRef<HTMLInputElement | null>(null);
  const controller = useRef<AbortController | null>(null);
  const current = useRef(0);
  const preview = useRef<string | null>(null);
  const [view, setView] = useState<View>({ status: "locked" });

  useEffect(() => {
    const clear = () => { current.current++; controller.current?.abort(); if (preview.current) URL.revokeObjectURL(preview.current);
      preview.current = null; setView({ status: "locked" }); };
    const ready = () => setView({ status: "idle" });
    window.addEventListener("vaultx:key-clear", clear);
    window.addEventListener("vaultx:key-ready", ready);
    let mounted = true;
    queueMicrotask(() => { if (mounted) setView({ status: hasVaultRootKey() ? "idle" : "locked" }); });
    // These refs hold the current in-memory operation, not DOM nodes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    return () => { mounted = false; current.current++; controller.current?.abort(); if (preview.current) URL.revokeObjectURL(preview.current);
      window.removeEventListener("vaultx:key-clear", clear); window.removeEventListener("vaultx:key-ready", ready); };
  }, []);

  const cancel = () => { current.current++; controller.current?.abort(); setView({ status: "cancelled", message: messages.cancelled }); };

  async function choose(file: File | undefined) {
    if (!file || !hasVaultRootKey()) return;
    const id = ++current.current;
    controller.current?.abort();
    if (preview.current) URL.revokeObjectURL(preview.current);
    preview.current = null;
    const abort = new AbortController(); controller.current = abort;
    setView({ status: "working", message: "Loading local image optimizer…" });
    try {
      const { optimizeImage } = await import("@/lib/image/optimize-image");
      if (abort.signal.aborted || id !== current.current || !hasVaultRootKey()) return;
      const result = await optimizeImage(file, { signal: abort.signal, onProgress: (message) => {
        if (id === current.current && hasVaultRootKey()) setView({ status: "working", message });
      } });
      if (abort.signal.aborted || id !== current.current || !hasVaultRootKey()) return;
      const previewUrl = URL.createObjectURL(result.blob);
      preview.current = previewUrl;
      setView({ status: "ready", result, previewUrl, sourceBytes: file.size });
    } catch (error) {
      if (id !== current.current || !hasVaultRootKey()) return;
      const message = error instanceof ImageOptimizationError ? messages[error.code] : "Image preparation failed. Nothing was uploaded.";
      setView({ status: "error", message });
    }
  }

  return <div className="space-y-7">
    <div><p className="text-xs font-semibold uppercase tracking-[0.2em] text-accent">Private library / Upload preparation</p>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">Prepare an image locally</h1>
      <p className="mt-3 max-w-2xl text-sm leading-6 text-muted">Choose a still image to see its optimized preview and estimated encrypted size. This screen does not upload or save files.</p></div>

    <div role="note" className="flex gap-3 rounded-2xl border border-accent/25 bg-accent/5 p-4 text-sm leading-6 text-muted sm:p-5">
      <ShieldCheck aria-hidden="true" size={21} className="mt-0.5 shrink-0 text-accent" />
      <p><strong className="text-foreground">Optimized-only storage policy:</strong> when encrypted uploads are implemented, VaultX will store the optimized image, not the original full-quality source. A future download will return that optimized format. No image leaves this device in this step.</p>
    </div>

    {view.status === "locked" ? <EmptyState icon={<LockKeyhole size={24} />} title="Vault key locked"
      description="Unlock your vault key in Settings before preparing an image."
      action={<Link href="/vault/settings" className="inline-flex min-h-11 items-center rounded-xl bg-accent px-5 text-sm font-medium text-accent-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">Open Settings</Link>} /> : <>
      <div className="rounded-2xl border border-line bg-surface p-5 sm:p-7">
        <input ref={input} type="file" accept="image/jpeg,image/png,image/webp,image/gif,image/heic,image/heif,.heic,.heif"
          className="sr-only" aria-label="Choose a still image" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; void choose(file); }} />
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3"><span aria-hidden="true" className="flex size-12 items-center justify-center rounded-xl bg-accent/10 text-accent"><ImagePlus size={22} /></span>
            <div><h2 className="font-medium">Local image optimizer</h2><p className="mt-1 text-xs text-muted">JPEG, PNG, WebP, still GIF, or decodable HEIC/HEIF · up to 50 MB source</p></div></div>
          <Button type="button" onClick={() => input.current?.click()} disabled={view.status === "working"}>Choose image</Button>
        </div>
        {view.status === "working" && <div role="status" aria-live="polite" className="mt-6 flex items-center justify-between gap-3 border-t border-line pt-5 text-sm text-muted">
          <span>{view.message}</span><Button type="button" variant="secondary" onClick={cancel}><X aria-hidden="true" size={16} />Cancel</Button></div>}
        {(view.status === "error" || view.status === "cancelled") && <p role="alert" className="mt-6 border-t border-line pt-5 text-sm text-danger">{view.message}</p>}
      </div>

      {view.status === "ready" && view.result && view.previewUrl && <section aria-label="Optimized image result" className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,0.8fr)]">
        <div className="flex min-h-56 items-center justify-center overflow-hidden rounded-2xl border border-line bg-[linear-gradient(45deg,#202525_25%,transparent_25%),linear-gradient(-45deg,#202525_25%,transparent_25%),linear-gradient(45deg,transparent_75%,#202525_75%),linear-gradient(-45deg,transparent_75%,#202525_75%)] bg-[length:24px_24px] bg-[position:0_0,0_12px,12px_-12px,-12px_0] p-4">
          {/* The object URL exists only in this browser session and is revoked on lock/change. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={view.previewUrl} alt="Optimized image preview" className="max-h-[30rem] max-w-full object-contain" />
        </div>
        <div className="rounded-2xl border border-line bg-surface p-5 sm:p-7"><h2 className="text-lg font-semibold">Local result</h2>
          <dl className="mt-5 space-y-4 text-sm">
            <div><dt className="text-muted">Source bytes</dt><dd className="mt-1">{size(view.sourceBytes ?? 0)}</dd></div>
            <div><dt className="text-muted">Optimized format and dimensions</dt><dd className="mt-1">{view.result.metadata.mimeType.replace("image/", "").toUpperCase()} · {view.result.width} × {view.result.height}</dd></div>
            <div><dt className="text-muted">Optimized image bytes</dt><dd className="mt-1">{view.result.blob.size.toLocaleString()}</dd></div>
            <div><dt className="text-muted">Estimated encrypted object</dt><dd className="mt-1">{view.result.estimatedCiphertextBytes.toLocaleString()} bytes</dd></div>
            <div><dt className="text-muted">Preferred 950,000-byte target</dt><dd className="mt-1">{view.result.preferredTargetMet ? "Met" : "Not met; still below the strict 1,000,000-byte limit"}</dd></div>
          </dl>
          {view.result.qualityWarning && <p className="mt-5 rounded-xl border border-amber-400/25 bg-amber-400/5 p-3 text-xs leading-5 text-amber-200">The encoder reduced quality or dimensions substantially. Review the preview before using this result in a future upload.</p>}
          <p className="mt-5 text-xs leading-5 text-muted">This is a prediction from the v1 encryption format. A future upload must still verify the actual Cloudinary ciphertext object size before marking a file ready.</p>
        </div>
      </section>}
    </>}
  </div>;
}

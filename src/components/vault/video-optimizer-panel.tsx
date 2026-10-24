"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Film, LockKeyhole, ShieldCheck, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { hasVaultRootKey } from "@/lib/crypto/key-memory";
import { VideoOptimizationError } from "@/lib/video/video-policy";
import type { VideoOptimizationResult, VideoProgress } from "@/lib/video/optimize-video";

type View = { status: "locked" | "idle" | "working" | "ready" | "error" | "cancelled";
  message?: string; result?: VideoOptimizationResult; previewUrl?: string; sourceBytes?: number };

const messages: Record<VideoOptimizationError["code"], string> = {
  unsupported: "This video container, track layout, or rotation is unsupported. Try an MP4, MOV, or WebM with one video, at most one audio track, and no subtitle or extra tracks.",
  corrupt: "This video could not be inspected. Choose a valid, complete file and try again.",
  device_limit: "This video needs more browser memory than this device can safely provide. A 500 MB source may work on a high-memory desktop, but is not supported here. Nothing was uploaded.",
  quality_floor: "The video cannot fit under the encrypted 100 MB limit at the minimum bitrate and resolution. Try a shorter clip or a different source.",
  encoder_unavailable: "The local video encoder could not start in this browser. Try an up-to-date desktop browser or a device with more memory.",
  transcode_failed: "Local transcoding failed or timed out. Nothing was uploaded. Try a shorter video or another browser.",
  validation_failed: "The resulting MP4 failed codec, audio, rotation, duration, or size checks. Nothing was uploaded.",
  cancelled: "Video preparation cancelled. Nothing was uploaded.",
};

function formatBytes(bytes: number): string { return `${(bytes / 1_000_000).toFixed(2)} MB`; }
function formatDuration(seconds: number): string { return `${Math.round(seconds * 10) / 10} seconds`; }
function progressMessage(progress: VideoProgress): string {
  if (progress.stage === "loading") return "Loading the local video encoder (about 32 MB)…";
  if (progress.stage === "inspecting") return "Inspecting video, audio, duration, and orientation locally…";
  if (progress.stage === "planning") return "Calculating the encrypted-size bitrate budget…";
  if (progress.stage === "validating") return "Checking the MP4 video, audio, duration, and exact size…";
  return `Transcoding ${progress.preset ?? "video"} locally · ${progress.percent ?? 0}%`;
}

export function VideoOptimizerPanel() {
  const input = useRef<HTMLInputElement | null>(null);
  const controller = useRef<AbortController | null>(null);
  const current = useRef(0);
  const preview = useRef<string | null>(null);
  const [view, setView] = useState<View>({ status: "locked" });

  useEffect(() => {
    const clear = () => { current.current++; controller.current?.abort();
      if (preview.current) URL.revokeObjectURL(preview.current);
      preview.current = null; setView({ status: "locked" }); };
    const ready = () => setView({ status: "idle" });
    window.addEventListener("vaultx:key-clear", clear);
    window.addEventListener("vaultx:key-ready", ready);
    let mounted = true;
    queueMicrotask(() => { if (mounted) setView({ status: hasVaultRootKey() ? "idle" : "locked" }); });
    // These refs own an active local worker and object URL.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    return () => { mounted = false; current.current++; controller.current?.abort();
      if (preview.current) URL.revokeObjectURL(preview.current);
      window.removeEventListener("vaultx:key-clear", clear); window.removeEventListener("vaultx:key-ready", ready); };
  }, []);

  const cancel = () => { current.current++; controller.current?.abort();
    setView({ status: "cancelled", message: messages.cancelled }); };

  async function choose(file: File | undefined) {
    if (!file || !hasVaultRootKey()) return;
    const id = ++current.current;
    controller.current?.abort();
    if (preview.current) URL.revokeObjectURL(preview.current);
    preview.current = null;
    const abort = new AbortController(); controller.current = abort;
    setView({ status: "working", message: "Loading local video code…" });
    try {
      const { optimizeVideo } = await import("@/lib/video/optimize-video");
      if (abort.signal.aborted || id !== current.current || !hasVaultRootKey()) return;
      const result = await optimizeVideo(file, { signal: abort.signal, onProgress: (progress) => {
        if (id === current.current && hasVaultRootKey()) setView({ status: "working", message: progressMessage(progress) });
      } });
      if (abort.signal.aborted || id !== current.current || !hasVaultRootKey()) return;
      const previewUrl = URL.createObjectURL(result.blob);
      preview.current = previewUrl;
      setView({ status: "ready", result, previewUrl, sourceBytes: file.size });
    } catch (error) {
      if (id !== current.current || !hasVaultRootKey()) return;
      setView({ status: "error", message: error instanceof VideoOptimizationError ? messages[error.code]
        : "Video preparation failed locally. Nothing was uploaded." });
    }
  }

  return <section aria-labelledby="video-preparation-title" className="space-y-6 border-t border-line pt-10">
    <div><p className="text-xs font-semibold uppercase tracking-[0.2em] text-accent">Video / On-device preparation</p>
      <h2 id="video-preparation-title" className="mt-2 text-2xl font-semibold tracking-tight sm:text-3xl">Prepare a video locally</h2>
      <p className="mt-3 max-w-2xl text-sm leading-6 text-muted">Inspect and transcode a supported clip to phone-friendly MP4 with H.264 video and AAC audio. This may take time and substantial device memory. No video is uploaded or saved by this screen.</p></div>

    <div role="note" className="flex gap-3 rounded-2xl border border-accent/25 bg-accent/5 p-4 text-sm leading-6 text-muted sm:p-5">
      <ShieldCheck aria-hidden="true" size={21} className="mt-0.5 shrink-0 text-accent" />
      <p><strong className="text-foreground">Optimized-only storage policy:</strong> a future encrypted upload will store the optimized MP4, not your original video. The output stays on this device today. Large clips, including 500 MB files, may be rejected when the device cannot safely transcode them.</p>
    </div>

    {view.status === "locked" ? <EmptyState icon={<LockKeyhole size={24} />} title="Vault key locked"
      description="Unlock your vault key in Settings before preparing a video."
      action={<Link href="/vault/settings" className="inline-flex min-h-11 items-center rounded-xl bg-accent px-5 text-sm font-medium text-accent-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">Open Settings</Link>} /> : <>
      <div className="rounded-2xl border border-line bg-surface p-5 sm:p-7">
        <input ref={input} type="file" accept="video/mp4,video/quicktime,video/webm,.mp4,.mov,.webm"
          className="sr-only" aria-label="Choose a video" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; void choose(file); }} />
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3"><span aria-hidden="true" className="flex size-12 items-center justify-center rounded-xl bg-accent/10 text-accent"><Film size={22} /></span>
            <div><h3 className="font-medium">Local video optimizer</h3><p className="mt-1 text-xs text-muted">MP4, MOV, WebM · up to 600 MB source, subject to device memory</p></div></div>
          <Button type="button" onClick={() => input.current?.click()} disabled={view.status === "working"}>Choose video</Button>
        </div>
        {view.status === "working" && <div role="status" aria-live="polite" className="mt-6 flex items-center justify-between gap-3 border-t border-line pt-5 text-sm text-muted">
          <span>{view.message}</span><Button type="button" variant="secondary" onClick={cancel}><X aria-hidden="true" size={16} />Cancel</Button></div>}
        {(view.status === "error" || view.status === "cancelled") && <p role="alert" className="mt-6 border-t border-line pt-5 text-sm text-danger">{view.message}</p>}
      </div>

      {view.status === "ready" && view.result && view.previewUrl && <section aria-label="Optimized video result" className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,0.8fr)]">
        <div className="flex min-h-56 items-center justify-center overflow-hidden rounded-2xl border border-line bg-black p-3">
          <video src={view.previewUrl} controls playsInline preload="metadata" className="max-h-[30rem] max-w-full" aria-label="Optimized video preview" />
        </div>
        <div className="rounded-2xl border border-line bg-surface p-5 sm:p-7"><h3 className="text-lg font-semibold">Local MP4 result</h3>
          <dl className="mt-5 space-y-4 text-sm">
            <div><dt className="text-muted">Source</dt><dd className="mt-1">{formatBytes(view.sourceBytes ?? 0)} · {view.result.input.format.toUpperCase()} · {formatDuration(view.result.input.durationSeconds)}</dd></div>
            <div><dt className="text-muted">Output</dt><dd className="mt-1">H.264 / {view.result.output.audioCodec ? "AAC audio" : "no audio"} · {view.result.output.width} × {view.result.output.height} · {view.result.preset.label}</dd></div>
            <div><dt className="text-muted">Output duration</dt><dd className="mt-1">{formatDuration(view.result.output.durationSeconds)}</dd></div>
            <div><dt className="text-muted">MP4 bytes</dt><dd className="mt-1">{view.result.blob.size.toLocaleString()}</dd></div>
            <div><dt className="text-muted">Estimated encrypted object</dt><dd className="mt-1">{view.result.estimatedCiphertextBytes.toLocaleString()} bytes</dd></div>
            <div><dt className="text-muted">Preferred 95,000,000-byte target</dt><dd className="mt-1">{view.result.preferredTargetMet ? "Met" : "Not met; still below the strict 100,000,000-byte limit"}</dd></div>
          </dl>
          <p className="mt-5 text-xs leading-5 text-muted">This is a local v1 encryption-size prediction. A future upload must verify the actual private Cloudinary ciphertext object before a file can become ready. Review picture and sound before using a future upload flow.</p>
        </div>
      </section>}
    </>}
  </section>;
}

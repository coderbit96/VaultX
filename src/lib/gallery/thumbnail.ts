"use client";

export class ThumbnailError extends Error {}

export function thumbnailDimensions(width: number, height: number, longestEdge = 512) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) throw new ThumbnailError("invalid_image");
  const scale = Math.min(1, longestEdge / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

export async function createLocalThumbnail(blob: Blob, signal?: AbortSignal): Promise<{ blob: Blob; width: number; height: number }> {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  const image = await createImageBitmap(blob);
  let canvas: HTMLCanvasElement | undefined;
  try {
    const size = thumbnailDimensions(image.width, image.height, 320);
    const activeCanvas = document.createElement("canvas"); canvas = activeCanvas;
    activeCanvas.width = size.width; activeCanvas.height = size.height;
    const context = activeCanvas.getContext("2d", { alpha: true });
    if (!context) throw new ThumbnailError("canvas_unavailable");
    context.drawImage(image, 0, 0, size.width, size.height);
    const output = await new Promise<Blob | null>((resolve) => activeCanvas.toBlob(resolve, "image/webp", 0.72));
    if (!output || output.type !== "image/webp" || signal?.aborted) throw new ThumbnailError("encoding_failed");
    return { blob: output, ...size };
  } finally {
    if (canvas) { canvas.width = 0; canvas.height = 0; }
    image.close();
  }
}

/** Creates a temporary local frame from an optimized MP4. No source bytes leave the browser. */
export async function createLocalVideoThumbnail(blob: Blob, signal?: AbortSignal): Promise<Blob> {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  const url = URL.createObjectURL(blob);
  const video = document.createElement("video");
  video.muted = true; video.playsInline = true; video.preload = "auto";
  let canvas: HTMLCanvasElement | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timer);
        video.removeEventListener("loadeddata", loaded);
        video.removeEventListener("error", failed);
        signal?.removeEventListener("abort", aborted);
        if (error) reject(error); else resolve();
      };
      const loaded = () => finish();
      const failed = () => finish(new ThumbnailError("video_preview_unavailable"));
      const aborted = () => finish(new DOMException("Aborted", "AbortError"));
      const timer = setTimeout(() => finish(new ThumbnailError("video_preview_timeout")), 10_000);
      video.addEventListener("loadeddata", loaded, { once: true });
      video.addEventListener("error", failed, { once: true });
      signal?.addEventListener("abort", aborted, { once: true });
      if (signal?.aborted) { aborted(); return; }
      video.src = url;
      video.load();
    });
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const size = thumbnailDimensions(video.videoWidth, video.videoHeight, 320);
    const activeCanvas = document.createElement("canvas"); canvas = activeCanvas;
    activeCanvas.width = size.width; activeCanvas.height = size.height;
    const context = activeCanvas.getContext("2d");
    if (!context) throw new ThumbnailError("canvas_unavailable");
    context.drawImage(video, 0, 0, size.width, size.height);
    const output = await new Promise<Blob | null>((resolve) => activeCanvas.toBlob(resolve, "image/webp", 0.72));
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    if (!output || output.type !== "image/webp") throw new ThumbnailError("encoding_failed");
    return output;
  } finally {
    if (canvas) { canvas.width = 0; canvas.height = 0; }
    video.pause(); video.removeAttribute("src"); video.load();
    URL.revokeObjectURL(url);
  }
}

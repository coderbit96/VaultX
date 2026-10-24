import { assertStoredByteLimit, estimateEncryptedFileBytes, type MetadataInput } from "@/lib/crypto/file-container";
import { LocalFFmpeg } from "./ffmpeg-local";
import { inspectVideoSignature, parseVideoProbe, planVideoPresets, videoMetadata, VIDEO_HARD_OBJECT_BYTES,
  VideoOptimizationError, type VideoInspection, type VideoPreset } from "./video-policy";

export type VideoProgress = { stage: "loading" | "inspecting" | "planning" | "transcoding" | "validating";
  percent?: number; preset?: string };
export type VideoOptimizationResult = { blob: Blob; metadata: MetadataInput; input: VideoInspection;
  output: VideoInspection; preset: VideoPreset; estimatedCiphertextBytes: number; preferredTargetMet: boolean };

function cancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new VideoOptimizationError("cancelled");
}

function textFile(data: Uint8Array | string): string {
  return typeof data === "string" ? data : new TextDecoder().decode(data);
}

async function probe(ffmpeg: LocalFFmpeg, path: string, output: string, format: VideoInspection["format"],
  signal?: AbortSignal): Promise<{ inspection: VideoInspection; bytes: number }> {
  cancelled(signal);
  await ffmpeg.ffprobe(["-v", "error", "-show_streams", "-show_format", "-of", "json", path, "-o", output]);
  cancelled(signal);
  // This WASM ffprobe build has returned -1 even with complete, valid output.
  // The structured output itself is the evidence; missing/truncated output
  // fails in readFile/JSON/schema validation below.
  let data: string;
  try { data = textFile(await ffmpeg.readFile(output)); }
  catch { throw new VideoOptimizationError("corrupt"); }
  await ffmpeg.deleteFile(output);
  const inspection = parseVideoProbe(data, format);
  const parsed = JSON.parse(data) as { format?: { size?: string } };
  const bytes = Number(parsed.format?.size);
  if (!Number.isSafeInteger(bytes) || bytes < 1) throw new VideoOptimizationError("corrupt");
  return { inspection, bytes };
}

function deviceAllows(fileBytes: number): boolean {
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  // Large WorkerFS inputs are file backed, but the encoder still needs WASM
  // memory plus an output buffer. Fail on low/unknown memory before loading it.
  if (fileBytes > 256_000_000 && (memory === undefined || memory < 8)) return false;
  if (fileBytes > 128_000_000 && memory !== undefined && memory < 4) return false;
  return true;
}

export async function optimizeVideo(file: File, options: { signal?: AbortSignal;
  onProgress?: (progress: VideoProgress) => void; uploadMaxObjectBytes?: number } = {}): Promise<VideoOptimizationResult> {
  const { signal, onProgress } = options;
  cancelled(signal);
  const format = await inspectVideoSignature(file);
  if (!deviceAllows(file.size)) throw new VideoOptimizationError("device_limit");
  cancelled(signal);
  onProgress?.({ stage: "loading" });
  const ffmpeg = new LocalFFmpeg();
  const stop = () => ffmpeg.terminate();
  signal?.addEventListener("abort", stop, { once: true });
  try {
    try {
      await ffmpeg.load();
    } catch { cancelled(signal); throw new VideoOptimizationError("encoder_unavailable"); }
    cancelled(signal);
    onProgress?.({ stage: "inspecting" });
    await ffmpeg.createDir("/input");
    // WORKERFS keeps the selected Blob file backed instead of copying a 500 MB
    // source into the main thread. The user filename never reaches a log path.
    const source = new File([file], "source.bin", { type: file.type });
    if (!await ffmpeg.mount("WORKERFS", { files: [source] }, "/input"))
      throw new VideoOptimizationError("encoder_unavailable");
    const probedInput = await probe(ffmpeg, "/input/source.bin", "/input-probe.json", format, signal);
    if (probedInput.bytes !== file.size) throw new VideoOptimizationError("corrupt");
    const input = probedInput.inspection;
    onProgress?.({ stage: "planning" });
    const metadata = videoMetadata(file.name);
    const presets = planVideoPresets(input, metadata, options.uploadMaxObjectBytes);
    const frameRate = Math.min(30, input.frameRate ?? 30);
    for (const preset of presets) {
      cancelled(signal);
      onProgress?.({ stage: "transcoding", percent: 0, preset: preset.label });
      const progress = ({ time }: { time: number }) => {
        const percent = Math.max(0, Math.min(99, Math.floor(time / 1_000_000 / input.durationSeconds * 100)));
        onProgress?.({ stage: "transcoding", percent, preset: preset.label });
      };
      ffmpeg.on("progress", progress);
      let status: number;
      try {
        const args = ["-hide_banner", "-loglevel", "error", "-i", "/input/source.bin", "-map", "0:v:0"];
        if (input.audioCodec) args.push("-map", "0:a:0");
        args.push("-map_metadata", "-1", "-map_chapters", "-1", "-sn", "-dn", "-vf",
          `fps=${frameRate},scale=${preset.width}:${preset.height}:flags=lanczos`,
          "-c:v", "libx264", "-preset", "veryfast", "-profile:v", "baseline", "-pix_fmt", "yuv420p",
          "-b:v", String(preset.videoBitsPerSecond), "-maxrate:v", String(preset.videoBitsPerSecond),
          "-bufsize:v", String(preset.videoBitsPerSecond * 2), "-metadata:s:v:0", "rotate=0");
        if (input.audioCodec) args.push("-c:a", "aac", "-b:a", String(preset.audioBitsPerSecond), "-ac", "2");
        else args.push("-an");
        args.push("-movflags", "+faststart", "-f", "mp4", "/output.mp4");
        status = await ffmpeg.exec(args, 30 * 60 * 1000);
      } catch { cancelled(signal); throw new VideoOptimizationError("transcode_failed"); }
      finally { ffmpeg.off("progress", progress); }
      cancelled(signal);
      if (status !== 0) throw new VideoOptimizationError("transcode_failed");
      onProgress?.({ stage: "validating", preset: preset.label });
      const result = await probe(ffmpeg, "/output.mp4", "/output-probe.json", "mp4", signal);
      const estimated = estimateEncryptedFileBytes(result.bytes, metadata);
      if (estimated >= BigInt(Math.min(VIDEO_HARD_OBJECT_BYTES, options.uploadMaxObjectBytes ?? VIDEO_HARD_OBJECT_BYTES))) { await ffmpeg.deleteFile("/output.mp4"); continue; }
      if (result.inspection.videoCodec !== "h264" || result.inspection.audioCodec !== (input.audioCodec ? "aac" : null)
        || result.inspection.rotation !== 0 || result.inspection.width !== preset.width || result.inspection.height !== preset.height
        || Math.abs(result.inspection.durationSeconds - input.durationSeconds) > Math.max(0.5, input.durationSeconds * 0.02)
        || (input.audioCodec && (result.inspection.audioDurationSeconds === null
          || Math.abs(result.inspection.audioDurationSeconds - result.inspection.durationSeconds) >
            Math.max(0.5, result.inspection.durationSeconds * 0.02))))
        throw new VideoOptimizationError("validation_failed");
      assertStoredByteLimit("video", estimated);
      const bytes = await ffmpeg.readFile("/output.mp4");
      cancelled(signal);
      if (bytes.byteLength !== result.bytes) throw new VideoOptimizationError("validation_failed");
      const exactBuffer = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
        ? bytes.buffer as ArrayBuffer : bytes.slice().buffer as ArrayBuffer;
      const blob = new Blob([exactBuffer], { type: "video/mp4" });
      await ffmpeg.deleteFile("/output.mp4");
      return { blob, metadata, input, output: result.inspection, preset,
        estimatedCiphertextBytes: Number(estimated), preferredTargetMet: estimated <= BigInt(95_000_000) };
    }
    throw new VideoOptimizationError("quality_floor");
  } catch (error) {
    if (signal?.aborted) throw new VideoOptimizationError("cancelled");
    if (error instanceof VideoOptimizationError) throw error;
    throw new VideoOptimizationError("transcode_failed");
  } finally {
    signal?.removeEventListener("abort", stop);
    ffmpeg.terminate();
  }
}

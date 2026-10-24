import { estimateEncryptedFileBytes, type MetadataInput } from "@/lib/crypto/file-container";

export const VIDEO_PREFERRED_OBJECT_BYTES = 95_000_000;
export const VIDEO_HARD_OBJECT_BYTES = 100_000_000;
export const VIDEO_MAX_SOURCE_BYTES = 600_000_000;
const MIN_CONTAINER_RESERVE = 500_000;

export class VideoOptimizationError extends Error {
  constructor(readonly code: "unsupported" | "corrupt" | "device_limit" | "quality_floor" | "encoder_unavailable" |
    "transcode_failed" | "validation_failed" | "cancelled") {
    super(code);
    this.name = "VideoOptimizationError";
  }
}

export type VideoInspection = {
  format: "mp4" | "mov" | "webm";
  width: number;
  height: number;
  rotation: 0 | 90 | 180 | 270;
  displayWidth: number;
  displayHeight: number;
  durationSeconds: number;
  frameRate: number | null;
  videoCodec: string;
  audioCodec: string | null;
  audioDurationSeconds: number | null;
};

export type VideoPreset = { label: string; width: number; height: number; videoBitsPerSecond: number;
  audioBitsPerSecond: number; targetObjectBytes: number };

export async function inspectVideoSignature(file: File): Promise<VideoInspection["format"]> {
  if (!file.size) throw new VideoOptimizationError("corrupt");
  if (file.size > VIDEO_MAX_SOURCE_BYTES) throw new VideoOptimizationError("device_limit");
  const bytes = new Uint8Array(await file.slice(0, 32).arrayBuffer());
  const ascii = new TextDecoder("ascii");
  let format: VideoInspection["format"];
  if (bytes.length >= 12 && ascii.decode(bytes.subarray(4, 8)) === "ftyp") {
    format = ascii.decode(bytes.subarray(8, 12)) === "qt  " ? "mov" : "mp4";
  } else if (bytes.length >= 4 && [0x1a, 0x45, 0xdf, 0xa3].every((value, index) => bytes[index] === value)) {
    format = "webm";
  } else throw new VideoOptimizationError("unsupported");
  const declared = file.type.toLowerCase();
  if (declared && declared !== "application/octet-stream" && !{
    mp4: ["video/mp4", "video/x-m4v", "video/quicktime"],
    mov: ["video/quicktime", "video/mp4"], webm: ["video/webm"],
  }[format].includes(declared)) throw new VideoOptimizationError("unsupported");
  return format;
}

function finitePositive(value: unknown): number {
  const number = typeof value === "number" || typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(number) || number <= 0) throw new VideoOptimizationError("corrupt");
  return number;
}

function fps(value: unknown): number | null {
  if (typeof value !== "string" || value === "0/0") return null;
  const [numerator, denominator = "1"] = value.split("/");
  const first = Number(numerator), second = Number(denominator);
  if (!Number.isFinite(first) || !Number.isFinite(second) || first <= 0 || second <= 0) return null;
  const rate = first / second;
  if (rate < 1 || rate > 240) return null;
  return rate;
}

export function parseVideoProbe(json: string, format: VideoInspection["format"]): VideoInspection {
  let raw: { streams?: Array<Record<string, unknown>>; format?: Record<string, unknown> };
  try { raw = JSON.parse(json); } catch { throw new VideoOptimizationError("corrupt"); }
  if (!raw || !Array.isArray(raw.streams)) throw new VideoOptimizationError("corrupt");
  const videos = raw.streams.filter((stream) => stream.codec_type === "video");
  const audios = raw.streams.filter((stream) => stream.codec_type === "audio");
  const extras = raw.streams.filter((stream) => stream.codec_type !== "video" && stream.codec_type !== "audio");
  // A single selected track is never allowed to silently discard other tracks.
  if (videos.length !== 1 || audios.length > 1 || extras.length) throw new VideoOptimizationError("unsupported");
  const video = videos[0];
  const width = finitePositive(video.width), height = finitePositive(video.height);
  const durationSeconds = finitePositive(raw.format?.duration);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width > 7680 || height > 4320 ||
    width * height > 33_177_600 || durationSeconds > 86_400) throw new VideoOptimizationError("unsupported");
  const sideData = Array.isArray(video.side_data_list) ? video.side_data_list as Array<Record<string, unknown>> : [];
  const tags = typeof video.tags === "object" && video.tags ? video.tags as Record<string, unknown> : {};
  const rotationValue = sideData.find((part) => part.rotation !== undefined)?.rotation ?? tags.rotate ?? 0;
  const normalized = ((Number(rotationValue) % 360) + 360) % 360;
  if (![0, 90, 180, 270].includes(normalized)) throw new VideoOptimizationError("unsupported");
  if (typeof video.codec_name !== "string" || (audios.length && typeof audios[0].codec_name !== "string"))
    throw new VideoOptimizationError("corrupt");
  const rotated = normalized === 90 || normalized === 270;
  const audioDuration = audios.length ? Number(audios[0].duration) : NaN;
  return { format, width, height, rotation: normalized as 0 | 90 | 180 | 270,
    displayWidth: rotated ? height : width, displayHeight: rotated ? width : height,
    durationSeconds, frameRate: fps(video.avg_frame_rate) ?? fps(video.r_frame_rate), videoCodec: video.codec_name,
    audioCodec: audios.length ? audios[0].codec_name as string : null,
    audioDurationSeconds: Number.isFinite(audioDuration) && audioDuration > 0 ? audioDuration : null };
}

export function videoMetadata(sourceName: string): MetadataInput {
  const clean = sourceName.replace(/[\\/]/g, "").normalize("NFC").replace(/[\p{Cc}\p{Cf}]/gu, "").trim();
  const stem = clean.replace(/\.[^.]+$/, "").trim() || "video";
  return { storedName: `${stem.slice(0, 251)}.mp4`, extension: "mp4", mimeType: "video/mp4" };
}

export function maxPlaintextForEncryptedTarget(objectBytes: number, metadata: MetadataInput): number {
  if (!Number.isSafeInteger(objectBytes) || objectBytes < 1) throw new VideoOptimizationError("quality_floor");
  let low = 0, high = objectBytes;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (estimateEncryptedFileBytes(middle, metadata) <= BigInt(objectBytes)) low = middle;
    else high = middle - 1;
  }
  return low;
}

const levels = [
  { label: "1080p", shortEdge: 1080, floor: 2_500_000, preferred: 5_000_000 },
  { label: "720p", shortEdge: 720, floor: 1_200_000, preferred: 2_500_000 },
  { label: "480p", shortEdge: 480, floor: 650_000, preferred: 1_200_000 },
  { label: "360p", shortEdge: 360, floor: 400_000, preferred: 700_000 },
];

export function planVideoPresets(inspection: VideoInspection, metadata: MetadataInput, uploadMaxObjectBytes = VIDEO_HARD_OBJECT_BYTES): VideoPreset[] {
  const audioBitsPerSecond = inspection.audioCodec ? 128_000 : 0;
  const presets: VideoPreset[] = [];
  for (const targetObjectBytes of [Math.min(VIDEO_PREFERRED_OBJECT_BYTES, Math.floor(uploadMaxObjectBytes * 0.95)), uploadMaxObjectBytes - 1]) {
    const maximumPlaintext = maxPlaintextForEncryptedTarget(targetObjectBytes, metadata);
    const containerReserve = Math.max(MIN_CONTAINER_RESERVE, Math.ceil(maximumPlaintext * 0.02));
    const bitrateBudget = Math.floor((maximumPlaintext - containerReserve) * 8 / inspection.durationSeconds) - audioBitsPerSecond;
    const seen = new Set<string>();
    for (const level of levels) {
      const short = Math.min(inspection.displayWidth, inspection.displayHeight);
      const scale = Math.min(1, level.shortEdge / short);
      const width = Math.max(2, Math.floor(inspection.displayWidth * scale / 2) * 2);
      const height = Math.max(2, Math.floor(inspection.displayHeight * scale / 2) * 2);
      const key = `${width}x${height}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const effectiveShort = Math.min(width, height);
      const resolved = levels.find((candidate) => effectiveShort >= candidate.shortEdge) ?? levels.at(-1)!;
      const floor = effectiveShort < 360 ? Math.max(220_000, Math.floor(400_000 * effectiveShort / 360)) : resolved.floor;
      if (bitrateBudget < floor) continue;
      presets.push({ label: `${effectiveShort}p`, width, height, videoBitsPerSecond: Math.min(resolved.preferred, bitrateBudget),
        audioBitsPerSecond, targetObjectBytes });
    }
    if (presets.length) break;
  }
  if (!presets.length) throw new VideoOptimizationError("quality_floor");
  return presets;
}

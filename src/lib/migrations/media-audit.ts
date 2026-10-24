import { createHash } from "node:crypto";
import { ObjectId } from "mongodb";
import { hasVerifiedCiphertext } from "@/lib/database/files";
import { fileSchema } from "@/lib/database/models";

export type MediaKind = "image" | "video" | "unknown";
export type ProviderReference = { publicId: string; resourceType: "image" | "video" | "raw"; deliveryType: "upload" | "private" | "authenticated" | "unknown" };
export type CandidateDisposition = "already-compatible" | "requires-client-reencryption" | "missing-asset-reference" | "not-media";

export type MediaCandidate = {
  sourceHash: string;
  collection: string;
  kind: MediaKind;
  provider: ProviderReference | null;
  disposition: CandidateDisposition;
  fields: {
    originalFilename: boolean;
    displayName: boolean;
    dates: boolean;
    dimensions: boolean;
    duration: boolean;
    tags: boolean;
    albumReference: boolean;
  };
};

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 512 ? value : null;
}
function kindOf(value: Record<string, unknown>): MediaKind {
  if (value.category === "image" || value.resource_type === "image" || value.resourceType === "image" || text(value.mime_type)?.startsWith("image/") || text(value.mimeType)?.startsWith("image/")) return "image";
  if (value.category === "video" || value.resource_type === "video" || value.resourceType === "video" || text(value.mime_type)?.startsWith("video/") || text(value.mimeType)?.startsWith("video/")) return "video";
  return "unknown";
}
function providerOf(value: Record<string, unknown>): ProviderReference | null {
  const cloudinary = record(value.cloudinary);
  const publicId = text(cloudinary?.publicId) ?? text(value.public_id) ?? text(value.publicId);
  if (!publicId) return null;
  const rawType = text(cloudinary?.resourceType) ?? text(value.resource_type) ?? text(value.resourceType);
  const resourceType = rawType === "image" || rawType === "video" || rawType === "raw" ? rawType : kindOf(value);
  if (resourceType === "unknown") return null;
  const rawDelivery = text(cloudinary?.deliveryType) ?? text(value.type) ?? text(value.delivery_type);
  const deliveryType = rawDelivery === "authenticated" || rawDelivery === "private" || rawDelivery === "upload" ? rawDelivery : "unknown";
  return { publicId, resourceType, deliveryType };
}
function hasAny(value: Record<string, unknown>, keys: string[]): boolean {
  return keys.some((key) => value[key] !== undefined && value[key] !== null);
}

/** Returns redacted migration facts only. Callers must never serialize the source document. */
export function inspectMediaCandidate(collection: string, source: unknown): MediaCandidate | null {
  const value = record(source);
  if (!value) return null;
  const kind = kindOf(value);
  const provider = providerOf(value);
  const looksLikeMedia = kind !== "unknown" || provider !== null || hasAny(value, ["secure_url", "thumbnail_url", "original_filename", "display_name"]);
  if (!looksLikeMedia) return null;
  const rawId = value._id instanceof ObjectId ? value._id.toHexString() : String(value._id ?? "missing");
  const parsed = fileSchema.safeParse(value);
  const compatible = parsed.success && (parsed.data.category === "image" || parsed.data.category === "video") && hasVerifiedCiphertext(parsed.data);
  const candidate: MediaCandidate = {
    sourceHash: createHash("sha256").update(`${collection}:${rawId}`).digest("hex").slice(0, 20),
    collection,
    kind,
    provider: null,
    disposition: compatible ? "already-compatible" : provider ? "requires-client-reencryption" : "missing-asset-reference",
    fields: {
      originalFilename: hasAny(value, ["original_filename", "originalFilename", "sourceNameEncrypted"]),
      displayName: hasAny(value, ["display_name", "displayName", "nameEncrypted"]),
      dates: hasAny(value, ["createdAt", "created_at", "updatedAt", "updated_at"]),
      dimensions: hasAny(value, ["width", "height"]),
      duration: hasAny(value, ["duration", "durationSeconds"]),
      tags: hasAny(value, ["tags", "tagsEncrypted"]),
      albumReference: hasAny(value, ["albumId", "album_id", "folderId"]),
    },
  };
  // The script may use this identity for an Admin API lookup, but accidental
  // JSON serialization of the candidate must never disclose a public ID.
  Object.defineProperty(candidate, "provider", { value: provider, enumerable: false });
  return candidate;
}

export function providerIdentity(reference: ProviderReference): string {
  return `${reference.resourceType}:${reference.deliveryType}:${reference.publicId}`;
}

export function redactProviderIdentity(reference: ProviderReference): string {
  return createHash("sha256").update(providerIdentity(reference)).digest("hex").slice(0, 20);
}

import { randomBytes } from "node:crypto";
import { ObjectId } from "mongodb";
import type { UploadJob } from "@/lib/database/models";
import { verifyProviderAsset, verifyStoredHeader, UploadLifecycleError, type ProviderAsset, type UploadProvider, type UploadStore } from "./lifecycle";

// Bounded by the verified account's 10 MiB raw-object cap. A larger plan needs
// a separate streaming review rather than buffering a 100 MB request here.
export const TRANSFER_MAX_BYTES = 10_000_000;

export interface CiphertextTransferProvider extends UploadProvider {
  upload(asset: UploadJob["cloudAssets"][number], ciphertext: Uint8Array): Promise<ProviderAsset>;
}

export async function readCiphertextBody(request: Request, expected: number): Promise<Uint8Array> {
  if (request.headers.get("content-type") !== "application/octet-stream"
    || !Number.isSafeInteger(expected) || expected < 81 || expected >= TRANSFER_MAX_BYTES
    || request.headers.get("content-length") !== String(expected) || !request.body) {
    throw new UploadLifecycleError("invalid_request");
  }
  const reader = request.body.getReader();
  const bytes = new Uint8Array(expected);
  let offset = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      if (offset + part.value.byteLength > expected) throw new UploadLifecycleError("invalid_request");
      bytes.set(part.value, offset);
      offset += part.value.byteLength;
    }
    if (offset !== expected) throw new UploadLifecycleError("invalid_request");
    return bytes;
  } finally { await reader.cancel().catch(() => undefined); }
}

export async function transferCiphertext(store: UploadStore, provider: CiphertextTransferProvider,
  ownerId: ObjectId, id: ObjectId, request: Request, now = new Date(), index = 0): Promise<"transferred" | "cancelled"> {
  const job = await store.getJob(ownerId, id);
  if (!job) throw new UploadLifecycleError("not_found");
  if (index !== 0 && index !== 1) throw new UploadLifecycleError("invalid_request");
  if (index === 1 && (!job.thumbnailManifest || !job.cloudAssets[0]?.assetId)) throw new UploadLifecycleError("conflict");
  if (!job.manifest || !job.ciphertextBytes || !job.intentExpiresAt || job.intentExpiresAt <= now
    || job.cancelRequestedAt || job.status === "cancelled" || job.status === "completed") throw new UploadLifecycleError("conflict");
  const bytes = await readCiphertextBody(request, index === 0 ? job.ciphertextBytes : Number(job.thumbnailManifest?.objectBytes));
  verifyStoredHeader(job, bytes.subarray(0, 80), index);
  const token = randomBytes(16).toString("hex");
  const acquired = await store.acquire(ownerId, id, "transfer", token, new Date(now.getTime() + 10 * 60_000), now);
  if (!acquired) throw new UploadLifecycleError("conflict");
  const planned = acquired.cloudAssets[index];
  try {
    // A timed-out response may have left a valid object. Recover its immutable
    // identity instead of overwriting or creating another ready file.
    const found = await provider.lookup(planned);
    const asset = found ?? await provider.upload(planned, bytes);
    verifyProviderAsset({ ...acquired, cloudAssets: acquired.cloudAssets.map((value, position) =>
      position === index ? { ...value, assetId: asset.assetId } : value) }, asset, index);
    if (found) verifyStoredHeader(acquired, await provider.readHeader(planned, asset.bytes), index);
    if ((await store.getJob(ownerId, id))?.cancelRequestedAt) {
      for (const entry of acquired.cloudAssets) {
        if (await provider.lookup(entry)) {
          await provider.destroy(entry);
          if (await provider.lookup(entry)) throw new UploadLifecycleError("unavailable");
        }
      }
      await store.recordState(acquired, token, "cancelled", undefined, new Date());
      return "cancelled";
    }
    await store.recordAsset(acquired, token, asset, new Date(), index);
    return "transferred";
  } catch (error) {
    await store.recordState(acquired, token, "retrying", error instanceof UploadLifecycleError ? error.code : "provider_unavailable", new Date()).catch(() => undefined);
    throw error instanceof UploadLifecycleError ? error : new UploadLifecycleError("unavailable");
  } finally { bytes.fill(0); }
}

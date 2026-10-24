import type { v2 as Cloudinary } from "cloudinary";
import { DeletionFailure, type DeletionAsset, type DeletionProvider } from "@/lib/deletions/file-deletion";

function isMissing(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const value = error as { http_code?: unknown; error?: { http_code?: unknown } };
  return value.http_code === 404 || value.error?.http_code === 404;
}

export function cloudinaryDeletionProvider(client: typeof Cloudinary): DeletionProvider {
  async function lookup(asset: DeletionAsset): Promise<Record<string, unknown> | null> {
    try {
      // SDK 2.11.0 implements this Admin method but omits its TS declaration.
      const byAssetId = (client.api as typeof client.api & { resource_by_asset_id(id: string): Promise<unknown> }).resource_by_asset_id;
      const result: unknown = asset.assetId ? await byAssetId(asset.assetId)
        : await client.api.resource(asset.publicId, { resource_type: asset.resourceType, type: asset.deliveryType });
      if (!result || typeof result !== "object") throw new DeletionFailure("provider_unavailable");
      return result as Record<string, unknown>;
    } catch (error) {
      if (isMissing(error)) return null;
      throw new DeletionFailure("provider_unavailable");
    }
  }
  return { async remove(asset) {
    if (asset.resourceType !== "raw" || asset.deliveryType !== "authenticated"
      || !/^vaultx\/(?:ciphertext|thumbnails)\/[a-f0-9]{48}\.dat$/.test(asset.publicId)) {
      throw new DeletionFailure("invalid_inventory");
    }
    const before = await lookup(asset);
    if (!before) return; // The recorded immutable asset is already absent.
    if (before.public_id !== asset.publicId || before.resource_type !== asset.resourceType
      || before.type !== asset.deliveryType || (asset.assetId && before.asset_id !== asset.assetId)) {
      throw new DeletionFailure("identity_mismatch");
    }
    try {
      const result: unknown = await client.uploader.destroy(asset.publicId,
        { resource_type: asset.resourceType, type: asset.deliveryType, invalidate: true });
      if (!result || typeof result !== "object" || !["ok", "not found"].includes(String((result as { result?: unknown }).result))) {
        throw new DeletionFailure("provider_unavailable");
      }
    } catch { throw new DeletionFailure("provider_unavailable"); }
    // The destroy acknowledgement alone is not enough. Verify the immutable
    // asset disappeared from active Cloudinary storage before updating the job.
    const after = await lookup(asset);
    if (after) throw new DeletionFailure("provider_unavailable");
  } };
}

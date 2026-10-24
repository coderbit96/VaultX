import type { v2 as Cloudinary } from "cloudinary";
import type { ProviderAsset } from "@/lib/uploads/lifecycle";
import type { CiphertextTransferProvider } from "@/lib/uploads/transfer";
import { cloudinaryCiphertextUploadOptions } from "./upload-intent";
import type { UploadJob } from "@/lib/database/models";

type Asset = UploadJob["cloudAssets"][number];

function isMissing(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { http_code?: unknown; error?: { http_code?: unknown } };
  return candidate.http_code === 404 || candidate.error?.http_code === 404;
}

export function cloudinaryUploadProvider(client: typeof Cloudinary): CiphertextTransferProvider {
  return {
    async upload(asset: Asset, ciphertext: Uint8Array): Promise<ProviderAsset> {
      const options = cloudinaryCiphertextUploadOptions(asset.publicId);
      const result = await new Promise<Record<string, unknown>>((resolve, reject) => {
        const stream = client.uploader.upload_stream(options, (error, response) => {
          if (error || !response) reject(new Error("Cloudinary upload unavailable"));
          else resolve(response as unknown as Record<string, unknown>);
        });
        stream.on("error", () => reject(new Error("Cloudinary upload unavailable")));
        stream.end(Buffer.from(ciphertext));
      });
      return { assetId: String(result.asset_id ?? ""), publicId: String(result.public_id ?? ""),
        resourceType: String(result.resource_type ?? ""), deliveryType: String(result.type ?? ""),
        format: String(result.format ?? ""), bytes: Number(result.bytes), version: Number(result.version) };
    },
    async lookup(asset: Asset): Promise<ProviderAsset | null> {
      try {
        // Always select the server-recorded opaque ID and intended restricted mode.
        // SDK 2.11.0 implements this Admin method but omits its TypeScript declaration.
        const byAssetId = (client.api as typeof client.api & { resource_by_asset_id(id: string): Promise<unknown> }).resource_by_asset_id;
        const raw: unknown = asset.assetId
          ? await byAssetId(asset.assetId)
          : await client.api.resource(asset.publicId, { resource_type: "raw", type: "authenticated" });
        if (typeof raw !== "object" || raw === null) throw new Error("Invalid provider response");
        const value = raw as Record<string, unknown>;
        return { assetId: String(value.asset_id ?? ""), publicId: String(value.public_id ?? ""),
          resourceType: String(value.resource_type ?? ""), deliveryType: String(value.type ?? ""),
          format: String(value.format ?? ""), bytes: Number(value.bytes), version: Number(value.version) };
      } catch (error) {
        if (isMissing(error)) return null;
        throw new Error("Cloudinary lookup unavailable");
      }
    },
    async readHeader(asset: Asset, totalBytes: number): Promise<Uint8Array> {
      try {
        const url = client.url(asset.publicId, { resource_type: "raw", type: "authenticated", secure: true, sign_url: true });
        const response = await fetch(url, { headers: { Range: "bytes=0-79" }, cache: "no-store", redirect: "error" });
        if (response.status !== 206 || response.headers.get("content-range") !== `bytes 0-79/${totalBytes}`) {
          await response.body?.cancel();
          throw new Error("Invalid ciphertext range response");
        }
        const reader = response.body?.getReader();
        if (!reader) throw new Error("Missing ciphertext range body");
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > 80) throw new Error("Oversized ciphertext range");
            chunks.push(value);
          }
        } finally { await reader.cancel().catch(() => undefined); }
        if (size !== 80) throw new Error("Truncated ciphertext range");
        return Uint8Array.from(Buffer.concat(chunks));
      } catch { throw new Error("Cloudinary ciphertext range unavailable"); }
    },
    async destroy(asset: Asset): Promise<void> {
      try {
        const result: unknown = await client.uploader.destroy(asset.publicId,
          { resource_type: "raw", type: "authenticated", invalidate: true });
        if (typeof result !== "object" || result === null || !["ok", "not found"].includes(String((result as { result?: unknown }).result))) {
          throw new Error("Unconfirmed Cloudinary deletion");
        }
      } catch { throw new Error("Cloudinary deletion unavailable"); }
    },
  };
}

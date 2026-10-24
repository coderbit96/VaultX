import type { v2 as Cloudinary } from "cloudinary";
import type { VaultFile } from "@/lib/database/models";

export class CiphertextAccessError extends Error {
  constructor(readonly code: "invalid_range" | "unavailable") { super(code); }
}

export type CiphertextRange = { start: number; end: number; length: number };

export function parseSingleByteRange(value: string | null, total: number): CiphertextRange {
  if (!Number.isSafeInteger(total) || total < 1) throw new CiphertextAccessError("unavailable");
  if (value === null) return { start: 0, end: total - 1, length: total };
  const parsed = /^bytes=(\d*)-(\d*)$/i.exec(value.trim());
  if (!parsed || (!parsed[1] && !parsed[2])) throw new CiphertextAccessError("invalid_range");
  let start: number;
  let end: number;
  if (!parsed[1]) {
    const suffix = Number(parsed[2]);
    if (!Number.isSafeInteger(suffix) || suffix < 1) throw new CiphertextAccessError("invalid_range");
    start = suffix >= total ? 0 : total - suffix;
    end = total - 1;
  } else {
    start = Number(parsed[1]);
    end = parsed[2] ? Number(parsed[2]) : total - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= total) {
      throw new CiphertextAccessError("invalid_range");
    }
    end = Math.min(end, total - 1);
  }
  return { start, end, length: end - start + 1 };
}

function cancellingStream(body: ReadableStream<Uint8Array>, expectedLength: number): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let remaining = expectedLength;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const part = await reader.read();
        if (part.done) {
          if (remaining !== 0) throw new CiphertextAccessError("unavailable");
          controller.close();
        } else {
          if (part.value.byteLength === 0) return;
          if (part.value.byteLength > remaining) throw new CiphertextAccessError("unavailable");
          remaining -= part.value.byteLength;
          controller.enqueue(part.value);
        }
      } catch (error) {
        await reader.cancel().catch(() => undefined);
        controller.error(error);
      }
    },
    async cancel(reason) { await reader.cancel(reason).catch(() => undefined); },
  });
}

export function signedCiphertextUrl(client: typeof Cloudinary, file: VaultFile): string {
  const asset = file.cloudinary;
  if (!asset || asset.resourceType !== "raw" || asset.deliveryType !== "authenticated"
    || !/^vaultx\/ciphertext\/[a-f0-9]{48}\.dat$/.test(asset.publicId)) {
    throw new CiphertextAccessError("unavailable");
  }
  // This signed URL remains server-local and is never returned to the browser.
  return client.url(asset.publicId, { resource_type: "raw", type: "authenticated", secure: true, sign_url: true });
}

export function signedThumbnailUrl(client: typeof Cloudinary, file: VaultFile): string {
  const thumbnail = file.thumbnail;
  if (!thumbnail || !thumbnail.cloudinary.assetId || thumbnail.cloudinary.format !== "dat"
    || thumbnail.cloudinary.resourceType !== "raw" || thumbnail.cloudinary.deliveryType !== "authenticated"
    || !/^vaultx\/thumbnails\/[a-f0-9]{48}\.dat$/.test(thumbnail.cloudinary.publicId)
    || thumbnail.encryptionManifest.kind !== "thumbnail"
    || thumbnail.encryptionManifest.objectBytes !== String(thumbnail.storedSizeBytes)) {
    throw new CiphertextAccessError("unavailable");
  }
  return client.url(thumbnail.cloudinary.publicId,
    { resource_type: "raw", type: "authenticated", secure: true, sign_url: true });
}

export async function proxyCiphertextRange(input: {
  file: VaultFile;
  range: string | null;
  makeUrl: () => string;
  fetcher?: typeof fetch;
}): Promise<Response> {
  const total = input.file.storedSizeBytes;
  const resolved = parseSingleByteRange(input.range, total ?? 0);
  const upstream = await (input.fetcher ?? fetch)(input.makeUrl(), { method: "GET", cache: "no-store", redirect: "error",
    headers: { Range: `bytes=${resolved.start}-${resolved.end}`, Accept: "application/octet-stream" } });
  const expectedRange = `bytes ${resolved.start}-${resolved.end}/${total}`;
  const upstreamLength = upstream.headers.get("content-length");
  if (upstream.status !== 206 || upstream.headers.get("content-range") !== expectedRange
    || upstreamLength !== String(resolved.length) || !upstream.body) {
    await upstream.body?.cancel().catch(() => undefined);
    throw new CiphertextAccessError("unavailable");
  }
  const headers = new Headers({
    "Cache-Control": "private, no-store, max-age=0",
    "Content-Type": "application/octet-stream",
    "Content-Length": String(resolved.length),
    "Content-Range": expectedRange,
    "Accept-Ranges": "bytes",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    Vary: "Cookie",
  });
  return new Response(cancellingStream(upstream.body, resolved.length), { status: 206, headers });
}

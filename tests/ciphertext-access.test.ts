import assert from "node:assert/strict";
import test from "node:test";
import type { v2 as Cloudinary } from "cloudinary";
import type { VaultFile } from "../src/lib/database/models";
import { CiphertextAccessError, parseSingleByteRange, proxyCiphertextRange, signedCiphertextUrl, signedThumbnailUrl } from "../src/lib/cloudinary/ciphertext-access-core";

const file = {
  storedSizeBytes: 12,
  cloudinary: {
    publicId: "vaultx/ciphertext/0123456789abcdef0123456789abcdef0123456789abcdef.dat",
    assetId: "asset-test", resourceType: "raw", deliveryType: "authenticated", format: "dat",
  },
} as VaultFile;

test("single byte ranges are normalized and reject ambiguous or unsatisfiable input", () => {
  assert.deepEqual(parseSingleByteRange("bytes=2-6", 12), { start: 2, end: 6, length: 5 });
  assert.deepEqual(parseSingleByteRange("bytes=-4", 12), { start: 8, end: 11, length: 4 });
  assert.deepEqual(parseSingleByteRange("bytes=10-99", 12), { start: 10, end: 11, length: 2 });
  assert.deepEqual(parseSingleByteRange(null, 12), { start: 0, end: 11, length: 12 });
  for (const value of ["bytes=", "bytes=0-1,3-4", "items=0-1", "bytes=12-13", "bytes=4-2", "bytes=-0"]) {
    assert.throws(() => parseSingleByteRange(value, 12), (error: unknown) => error instanceof CiphertextAccessError && error.code === "invalid_range");
  }
});

test("gateway validates the upstream range and never returns the signed provider URL", async () => {
  const bytes = Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  let requestedRange = "";
  const response = await proxyCiphertextRange({ file, range: "bytes=3-7", makeUrl: () => "https://provider.invalid/a-signed-secret",
    fetcher: async (_url, init) => {
      requestedRange = new Headers(init?.headers).get("range") ?? "";
      return new Response(bytes.slice(3, 8), { status: 206, headers: { "content-range": "bytes 3-7/12", "content-length": "5" } });
    },
  });
  assert.equal(requestedRange, "bytes=3-7");
  assert.equal(response.status, 206);
  assert.equal(response.headers.get("content-range"), "bytes 3-7/12");
  assert.equal(response.headers.get("cache-control"), "private, no-store, max-age=0");
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [3, 4, 5, 6, 7]);
  assert.equal([...response.headers.entries()].join(" ").includes("a-signed-secret"), false);
});

test("gateway fails closed for provider status, range and length mismatches", async () => {
  for (const response of [
    new Response(Uint8Array.from([0]), { status: 200, headers: { "content-length": "1" } }),
    new Response(Uint8Array.from([0]), { status: 206, headers: { "content-range": "bytes 0-0/99", "content-length": "1" } }),
    new Response(Uint8Array.from([0]), { status: 206, headers: { "content-range": "bytes 0-0/12", "content-length": "2" } }),
  ]) {
    await assert.rejects(proxyCiphertextRange({ file, range: "bytes=0-0", makeUrl: () => "https://provider.invalid", fetcher: async () => response }),
      (error: unknown) => error instanceof CiphertextAccessError && error.code === "unavailable");
  }
});

test("cancelling the browser response cancels the provider stream", async () => {
  let cancelled = false;
  const source = new ReadableStream<Uint8Array>({
    pull(controller) { controller.enqueue(Uint8Array.from([0])); },
    cancel() { cancelled = true; },
  });
  const response = await proxyCiphertextRange({ file, range: "bytes=0-0", makeUrl: () => "https://provider.invalid",
    fetcher: async () => new Response(source, { status: 206, headers: { "content-range": "bytes 0-0/12", "content-length": "1" } }),
  });
  const reader = response.body!.getReader();
  await reader.read();
  await reader.cancel();
  assert.equal(cancelled, true);
});

test("gateway detects truncated and excess upstream bytes despite a matching Content-Length header", async () => {
  for (const bytes of [Uint8Array.from([1]), Uint8Array.from([1, 2, 3])]) {
    const response = await proxyCiphertextRange({ file, range: "bytes=0-1", makeUrl: () => "https://provider.invalid",
      fetcher: async () => new Response(bytes, { status: 206,
        headers: { "content-range": "bytes 0-1/12", "content-length": "2" } }),
    });
    await assert.rejects(response.arrayBuffer());
  }
});

test("only the fixed authenticated raw namespace can produce a server-side signed URL", () => {
  let options: Record<string, unknown> | undefined;
  const client = { url(_id: string, value: Record<string, unknown>) { options = value; return "https://provider.invalid/signed"; } } as unknown as typeof Cloudinary;
  assert.equal(signedCiphertextUrl(client, file), "https://provider.invalid/signed");
  assert.deepEqual(options, { resource_type: "raw", type: "authenticated", secure: true, sign_url: true });
  assert.throws(() => signedCiphertextUrl(client, { ...file, cloudinary: { ...file.cloudinary!, publicId: "outside/asset.dat" } }), CiphertextAccessError);
});

test("thumbnail URL signing requires a linked restricted encrypted preview", () => {
  const client = { url() { return "https://provider.invalid/private-preview"; } } as unknown as typeof Cloudinary;
  const thumb = { storedSizeBytes: 128, cloudinary: { publicId: `vaultx/thumbnails/${"a".repeat(48)}.dat`,
    assetId: "thumb", resourceType: "raw", deliveryType: "authenticated", format: "dat" },
  encryptionManifest: { kind: "thumbnail", objectBytes: "128" } };
  assert.equal(signedThumbnailUrl(client, { ...file, thumbnail: thumb } as VaultFile), "https://provider.invalid/private-preview");
  assert.throws(() => signedThumbnailUrl(client, { ...file, thumbnail: { ...thumb,
    cloudinary: { ...thumb.cloudinary, deliveryType: "upload" } } } as unknown as VaultFile), CiphertextAccessError);
  assert.throws(() => signedThumbnailUrl(client, { ...file, thumbnail: { ...thumb,
    storedSizeBytes: 129 } } as VaultFile), CiphertextAccessError);
});

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { authenticatedCiphertextSource, decryptToBlob, downloadName, previewKind } from "../src/lib/files/decrypt-client";
import { prepareEncryptedFile, type MetadataInput } from "../src/lib/crypto/file-container";
import { clearVaultKeyMaterial, installVaultRootKey } from "../src/lib/crypto/key-memory";

const vaultId = Buffer.from(randomBytes(16)).toString("base64url");
const root = new Uint8Array(randomBytes(32));
const metadata: MetadataInput = { storedName: "stored-photo.webp", extension: "webp", mimeType: "image/webp" };

async function fixture() {
  installVaultRootKey(root, vaultId);
  const prepared = await prepareEncryptedFile(new Blob([Uint8Array.from([1, 2, 3, 4, 5])]), metadata, "image");
  const chunks: Uint8Array[] = [];
  for await (const chunk of prepared.chunks()) chunks.push(chunk);
  return { cipher: new Blob(chunks.map((chunk) => chunk.slice().buffer)), manifest: prepared.manifest };
}

test("only allowlisted stored MIME and extension pairs are inline previewable", () => {
  assert.equal(previewKind("image/webp", "webp"), "image");
  assert.equal(previewKind("audio/mpeg", "mp3"), "audio");
  assert.equal(previewKind("application/pdf", "pdf"), "pdf");
  assert.equal(previewKind("text/plain", "txt"), "text");
  assert.equal(previewKind("image/svg+xml", "svg"), "none");
  assert.equal(previewKind("text/html", "html"), "none");
  assert.equal(previewKind("application/vnd.openxmlformats-officedocument.wordprocessingml.document", "docx"), "none");
  assert.equal(downloadName("../private/Report.old", "webp"), "..privateReport.webp");
});

test("range client decrypts exact authenticated chunks and rejects invalid provider ranges", async () => {
  const { cipher, manifest } = await fixture();
  const originalFetch = globalThis.fetch;
  const bytes = new Uint8Array(await cipher.arrayBuffer());
  let requests = 0;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const range = new Headers(init?.headers).get("range");
    const matched = /^bytes=(\d+)-(\d+)$/.exec(range ?? "");
    assert.ok(matched);
    const start = Number(matched![1]), end = Number(matched![2]); requests++;
    const part = bytes.slice(start, end + 1);
    return new Response(part, { status: 206, headers: { "content-range": `bytes ${start}-${end}/${bytes.length}`, "content-length": String(part.length) } });
  }) as typeof fetch;
  try {
    const result = await decryptToBlob("0123456789abcdef01234567", bytes.length, manifest,
      { extension: "webp", mimeType: "image/webp" });
    assert.deepEqual([...new Uint8Array(await result.blob.arrayBuffer())], [1, 2, 3, 4, 5]);
    assert.ok(requests >= 3); // header, encrypted metadata, and content chunk
  } finally { globalThis.fetch = originalFetch; clearVaultKeyMaterial(); }
});

test("ciphertext range source rejects a non-206 or malformed content range", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(Uint8Array.from([1]), { status: 200, headers: { "content-length": "1" } })) as typeof fetch;
  try { await assert.rejects(authenticatedCiphertextSource("0123456789abcdef01234567", 10).read(BigInt(0), BigInt(1))); }
  finally { globalThis.fetch = originalFetch; }
});

test("locked browser key cannot decrypt a stored object", async () => {
  const { cipher, manifest } = await fixture();
  const originalFetch = globalThis.fetch;
  const bytes = new Uint8Array(await cipher.arrayBuffer());
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const range = /^bytes=(\d+)-(\d+)$/.exec(new Headers(init?.headers).get("range") ?? "")!;
    const start = Number(range[1]), end = Number(range[2]), part = bytes.slice(start, end + 1);
    return new Response(part, { status: 206, headers: { "content-range": `bytes ${start}-${end}/${bytes.length}`, "content-length": String(part.length) } });
  }) as typeof fetch;
  clearVaultKeyMaterial();
  try { await assert.rejects(decryptToBlob("0123456789abcdef01234567", bytes.length, manifest, { extension: "webp", mimeType: "image/webp" })); }
  finally { globalThis.fetch = originalFetch; }
});

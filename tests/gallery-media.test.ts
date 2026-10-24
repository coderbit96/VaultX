import assert from "node:assert/strict";
import test from "node:test";
import { appendGallerySearchPage, matchesGallerySearch, mergeGalleryFiles, visibleGalleryFiles, type GalleryFile } from "../src/lib/gallery/media";

function file(id: string, category: GalleryFile["category"], name: string, createdAt: string): GalleryFile {
  return { id, category, name, createdAt, updatedAt: createdAt, folderId: null, extension: "webp",
    mimeType: "image/webp", storedSizeBytes: 500, nameEncrypted: {
      version: 1, vaultId: "A".repeat(22), nonce: "A".repeat(16), ciphertext: "A".repeat(24),
    } } as GalleryFile;
}

test("gallery includes only media, merges pages without duplicate cards and orders by date", () => {
  const older = file("a", "image", "Old", "2026-01-01T00:00:00.000Z");
  const newer = file("b", "video", "New", "2026-02-01T00:00:00.000Z");
  const document = file("c", "document", "Secret", "2026-03-01T00:00:00.000Z");
  assert.deepEqual(mergeGalleryFiles([older], [newer, older, document]).map((item) => item.id), ["b", "a"]);
});

test("gallery filters and sorts only locally decrypted names", () => {
  const files = mergeGalleryFiles([], [file("a", "image", "Zebra", "2026-01-01T00:00:00.000Z"),
    file("b", "video", "Aster", "2026-02-01T00:00:00.000Z")]);
  assert.deepEqual(visibleGalleryFiles(files, "image", "newest").map((item) => item.id), ["a"]);
  assert.deepEqual(visibleGalleryFiles(files, "all", "name").map((item) => item.id), ["b", "a"]);
  assert.deepEqual(visibleGalleryFiles(files, "all", "oldest").map((item) => item.id), ["a", "b"]);
});

test("gallery searches decrypted tags locally and sorts stored bytes", () => {
  const small = { ...file("a", "image", "Landscape", "2026-01-01T00:00:00.000Z"),
    storedSizeBytes: 450, tags: ["Holiday", "Sea"] };
  const large = { ...file("b", "video", "Clip", "2026-02-01T00:00:00.000Z"),
    storedSizeBytes: 2_000, tags: ["Family"] };
  assert.equal(matchesGallerySearch(small, "  HOLIDAY  "), true);
  assert.equal(matchesGallerySearch(large, "holiday"), false);
  assert.deepEqual(visibleGalleryFiles([small, large], "all", "size").map((item) => item.id), ["b", "a"]);
});

test("search pages stop at the card limit without skipping later matches", () => {
  const incoming = Array.from({ length: 36 }, (_, index) => ({
    ...file(String(index), "image", "Match", "2026-01-01T00:00:00.000Z"), cursor: `cursor-${index}`,
  }));
  const first = appendGallerySearchPage([], incoming, "match", null, 12);
  assert.equal(first.files.length, 12);
  assert.equal(first.nextCursor, "cursor-11");
  const second = appendGallerySearchPage([], incoming.slice(12), "match", null, 12);
  assert.equal(second.files.length, 12);
  assert.equal(second.nextCursor, "cursor-23");
  const sparse = appendGallerySearchPage([], incoming.slice(0, 2), "absent", "later", 12);
  assert.equal(sparse.nextCursor, "later");
  assert.equal(sparse.files.length, 0);
});

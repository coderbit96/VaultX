import assert from "node:assert/strict";
import test from "node:test";
import { thumbnailDimensions } from "../src/lib/gallery/thumbnail";

test("thumbnail dimensions preserve aspect ratio, never upscale, and reject invalid media", () => {
  assert.deepEqual(thumbnailDimensions(400, 200), { width: 400, height: 200 });
  assert.deepEqual(thumbnailDimensions(4_000, 2_000), { width: 512, height: 256 });
  assert.deepEqual(thumbnailDimensions(300, 900), { width: 171, height: 512 });
  assert.throws(() => thumbnailDimensions(0, 4));
});

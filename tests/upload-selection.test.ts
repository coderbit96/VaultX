import assert from "node:assert/strict";
import test from "node:test";
import { dedupeSelection, selectionKey } from "../src/lib/uploads/selection";

test("multi-selection skips repeated picks without dropping distinct files", () => {
  const first = new File(["one"], "synthetic.jpg", { type: "image/jpeg", lastModified: 42 });
  const repeat = new File(["one"], "synthetic.jpg", { type: "image/jpeg", lastModified: 42 });
  const other = new File(["two"], "different.jpg", { type: "image/jpeg", lastModified: 42 });
  const seen = new Set<string>();
  assert.deepEqual(dedupeSelection([first, repeat, other], seen), { accepted: [first, other], skipped: 1 });
  assert.deepEqual(dedupeSelection([repeat], seen), { accepted: [], skipped: 1 });
  assert.notEqual(selectionKey(first), selectionKey(other));
  seen.delete(selectionKey(first));
  assert.deepEqual(dedupeSelection([repeat], seen), { accepted: [repeat], skipped: 0 });
});

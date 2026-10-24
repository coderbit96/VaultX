import assert from "node:assert/strict";
import test from "node:test";
import { FragmentedMp4Error, inspectFragmentedMp4 } from "../src/lib/video/fmp4-structure";

function box(type: string, ...parts: Uint8Array[]): Uint8Array {
  const size = 8 + parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(size), view = new DataView(result.buffer);
  view.setUint32(0, size);
  result.set(new TextEncoder().encode(type), 4);
  let at = 8;
  for (const part of parts) { result.set(part, at); at += part.length; }
  return result;
}
function join(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) { result.set(part, at); at += part.length; }
  return result;
}
function fixture(flags = 0x020000) {
  const header = new Uint8Array(8); header[1] = flags >> 16; header[2] = flags >> 8; header[3] = flags;
  const track = box("traf", box("tfhd", header), box("tfdt", new Uint8Array(8)), box("trun", new Uint8Array(8)));
  return join(box("ftyp", new Uint8Array(8)), box("moov", box("mvex", new Uint8Array(8))),
    box("moof", track), box("mdat", new Uint8Array(128)), box("moof", track), box("mdat", new Uint8Array(64)));
}

test("fragmented MP4 inspector returns exact init and media byte spans", () => {
  const bytes = fixture();
  const result = inspectFragmentedMp4(bytes);
  assert.equal(result.init.start, 0);
  assert.equal(result.fragments.length, 2);
  assert.equal(result.init.end, result.fragments[0].start);
  assert.equal(result.fragments[0].end, result.fragments[1].start);
  assert.equal(result.fragments[1].end, bytes.length);
});

test("fragmented MP4 inspector rejects missing relative addressing and truncated boxes", () => {
  assert.throws(() => inspectFragmentedMp4(fixture(0)), FragmentedMp4Error);
  assert.throws(() => inspectFragmentedMp4(fixture(0x020001)), FragmentedMp4Error);
  assert.throws(() => inspectFragmentedMp4(fixture().subarray(0, -1)), FragmentedMp4Error);
});

test("ordinary fast-start MP4 cannot be labeled a fragmented stream", () => {
  assert.throws(() => inspectFragmentedMp4(join(box("ftyp", new Uint8Array(8)),
    box("moov", new Uint8Array(8)), box("mdat", new Uint8Array(128)))), FragmentedMp4Error);
});

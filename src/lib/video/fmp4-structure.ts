// Strict structural inspection for the proposed segmented-video format.
// This does not prove codec support, timing accuracy, keyframe independence,
// or MediaSource playback. Those require separate local and browser checks.
type Box = { type: string; start: number; end: number; headerBytes: number };

export type FragmentedMp4Structure = {
  init: { start: 0; end: number };
  fragments: Array<{ start: number; end: number }>;
  trailer?: { start: number; end: number };
};

export class FragmentedMp4Error extends Error {
  constructor() { super("invalid_fragmented_mp4"); this.name = "FragmentedMp4Error"; }
}

const MAX_INIT_BYTES = 256_000;
const MAX_MEDIA_FRAGMENT_BYTES = 3_700_000;
const MAX_TRAILER_BYTES = 256_000;

function boxes(bytes: Uint8Array, start: number, end: number): Box[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const result: Box[] = [];
  for (let at = start; at < end;) {
    if (end - at < 8) throw new FragmentedMp4Error();
    const size32 = view.getUint32(at);
    let headerBytes = 8;
    let size = size32;
    if (size32 === 1) {
      if (end - at < 16) throw new FragmentedMp4Error();
      const wide = view.getBigUint64(at + 8);
      if (wide > BigInt(Number.MAX_SAFE_INTEGER)) throw new FragmentedMp4Error();
      size = Number(wide); headerBytes = 16;
    }
    if (size < headerBytes || size > end - at) throw new FragmentedMp4Error();
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    if (!/^[a-z0-9]{4}$/.test(type)) throw new FragmentedMp4Error();
    result.push({ type, start: at, end: at + size, headerBytes });
    at += size;
  }
  return result;
}

function children(bytes: Uint8Array, parent: Box): Box[] {
  return boxes(bytes, parent.start + parent.headerBytes, parent.end);
}

export function inspectFragmentedMp4(bytes: Uint8Array): FragmentedMp4Structure {
  if (bytes.byteLength < 64 || bytes.byteLength >= 100_000_000) throw new FragmentedMp4Error();
  const top = boxes(bytes, 0, bytes.byteLength);
  if (top.length < 4 || top[0].type !== "ftyp" || top[0].start !== 0
    || top[1].type !== "moov" || top[0].end !== top[1].start
    || top[1].end > MAX_INIT_BYTES || !children(bytes, top[1]).some((box) => box.type === "mvex")) {
    throw new FragmentedMp4Error();
  }
  const fragments: Array<{ start: number; end: number }> = [];
  let trailer: { start: number; end: number } | undefined;
  for (let index = 2; index < top.length;) {
    const first = top[index];
    if (first.type === "mfra" && index === top.length - 1) {
      if (first.end - first.start > MAX_TRAILER_BYTES || !fragments.length) throw new FragmentedMp4Error();
      trailer = { start: first.start, end: first.end };
      index++;
      continue;
    }
    const media = top[index + 1];
    if (first.type !== "moof" || !media || media.type !== "mdat"
      || media.end - first.start > MAX_MEDIA_FRAGMENT_BYTES) throw new FragmentedMp4Error();
    const trackFragments = children(bytes, first).filter((box) => box.type === "traf");
    if (!trackFragments.length) throw new FragmentedMp4Error();
    for (const track of trackFragments) {
      const contents = children(bytes, track);
      const tfhd = contents.find((box) => box.type === "tfhd");
      const tfdt = contents.find((box) => box.type === "tfdt");
      const trun = contents.find((box) => box.type === "trun");
      if (!tfhd || !tfdt || !trun || tfhd.end - tfhd.start < tfhd.headerBytes + 8
        || tfdt.end - tfdt.start < tfdt.headerBytes + 8
        || trun.end - trun.start < trun.headerBytes + 8) throw new FragmentedMp4Error();
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const flags = view.getUint32(tfhd.start + tfhd.headerBytes) & 0x00ff_ffff;
      if (!(flags & 0x020000) || (flags & 0x000001)) throw new FragmentedMp4Error();
    }
    fragments.push({ start: first.start, end: media.end });
    index += 2;
  }
  if (!fragments.length) throw new FragmentedMp4Error();
  return { init: { start: 0, end: top[1].end }, fragments, ...(trailer ? { trailer } : {}) };
}

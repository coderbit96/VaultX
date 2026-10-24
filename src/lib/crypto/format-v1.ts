// Pure, allocation-free arithmetic for the proposed v1 ciphertext container.
// This is a contract aid, not an encryptor, parser, upload path, or media player.
export const V1_HEADER_BYTES = 80;
export const V1_CHUNK_BYTES = 1_048_576;
export const V1_TAG_BYTES = 16;
export const V1_MAX_METADATA_CIPHER_BYTES = 65_552;
export const V1_METADATA_NONCE_INDEX = 0xffff_ffff;

const MAX_PLAINTEXT_BYTES = (BigInt(1) << BigInt(64)) - BigInt(1);
const MAX_CHUNKS = V1_METADATA_NONCE_INDEX - 1;

export interface V1Layout {
  readonly plaintextLength: bigint;
  readonly metadataCiphertextLength: number;
  readonly chunkCount: number;
}

export interface V1ByteRange {
  readonly start: bigint;
  readonly endInclusive: bigint;
}

export function v1ChunkCount(plaintextLength: bigint): number {
  if (plaintextLength < BigInt(0) || plaintextLength > MAX_PLAINTEXT_BYTES) {
    throw new RangeError("Invalid v1 plaintext length");
  }
  const count = plaintextLength === BigInt(0)
    ? BigInt(1)
    : (plaintextLength + BigInt(V1_CHUNK_BYTES) - BigInt(1)) / BigInt(V1_CHUNK_BYTES);
  if (count > BigInt(MAX_CHUNKS)) throw new RangeError("Too many v1 chunks");
  return Number(count);
}

function validateLayout(layout: V1Layout): void {
  if (!Number.isInteger(layout.metadataCiphertextLength)
    || layout.metadataCiphertextLength < V1_TAG_BYTES
    || layout.metadataCiphertextLength > V1_MAX_METADATA_CIPHER_BYTES) {
    throw new RangeError("Invalid v1 metadata ciphertext length");
  }
  if (!Number.isInteger(layout.chunkCount)
    || layout.chunkCount !== v1ChunkCount(layout.plaintextLength)) {
    throw new RangeError("Invalid v1 chunk count");
  }
}

export function v1ChunkRange(layout: V1Layout, index: number): V1ByteRange {
  validateLayout(layout);
  if (!Number.isInteger(index) || index < 0 || index >= layout.chunkCount) {
    throw new RangeError("Invalid v1 chunk index");
  }
  const offset = BigInt(index) * BigInt(V1_CHUNK_BYTES);
  const plaintextBytes = layout.plaintextLength - offset < BigInt(V1_CHUNK_BYTES)
    ? layout.plaintextLength - offset
    : BigInt(V1_CHUNK_BYTES);
  const start = BigInt(V1_HEADER_BYTES + layout.metadataCiphertextLength)
    + BigInt(index) * BigInt(V1_CHUNK_BYTES + V1_TAG_BYTES);
  return { start, endInclusive: start + plaintextBytes + BigInt(V1_TAG_BYTES) - BigInt(1) };
}

export function v1ObjectBytes(layout: V1Layout): bigint {
  validateLayout(layout);
  return BigInt(V1_HEADER_BYTES + layout.metadataCiphertextLength)
    + layout.plaintextLength
    + BigInt(layout.chunkCount * V1_TAG_BYTES);
}

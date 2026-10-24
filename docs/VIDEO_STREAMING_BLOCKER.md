# Encrypted video streaming blocker

**Status: BLOCKED (rechecked 2026-10-23).** VaultX cannot truthfully provide encrypted, bounded-memory HTML5 playback or seeking with the current stored-video contract. The owner has now approved designing **new videos** as multiple small encrypted objects while leaving existing assets untouched. Approval does not implement or verify that format.

## Evidence

- `src/lib/video/optimize-video.ts` emits an ordinary fast-start MP4 using `-movflags +faststart`. It does not request fragmented MP4 output and does not inspect `moof`, `mdat`, `tfdt`, or keyframe boundaries.
- The v1 encrypted file container stores generic 1,048,576-byte AES-GCM chunks. It has no MP4 initialization-segment or fragment time/byte index in authenticated metadata.
- The existing ciphertext access gateway correctly authorizes and streams ciphertext ranges, but no browser fetcher maps a requested playback time to encrypted chunks, authenticates/decrypts them, or appends valid MP4 segments to a `SourceBuffer`.
- A full decrypted MP4 Blob would violate PRD §§7, 8.4 and 15.1. It is not a fallback for this feature.
- Android Chrome, desktop browsers, iOS Safari, and installed iOS PWA mode have not been tested with a real generated fragmented H.264/AAC asset. Their MediaSource and codec capability cannot be assumed.

## Required architectural change

1. Change the local FFmpeg output to constrained **fragmented MP4**: H.264 baseline-compatible video and AAC audio, a bounded `ftyp+moov` init segment, then independently decodable keyframe-aligned `moof+mdat` fragments. The exact FFmpeg muxer flags and generated box layout must be validated locally, not assumed from command success.
2. Extend authenticated encrypted metadata with a versioned fMP4 index: codec string, init byte range, each fragment's plaintext start/end, decode and presentation time, duration, and preceding independent keyframe. Bind it to the immutable encrypted header.
3. Reject video output that has an oversized init segment or fragment, lacks an independent seek fragment, does not meet H.264/AAC requirements, exceeds encrypted byte limits, or cannot fit the bounded metadata envelope.
4. Implement a browser-only MediaSource controller. It must first call `MediaSource.isTypeSupported()` for the exact recorded codec string, fetch/decrypt only the complete encrypted chunks enclosing the init segment and needed fragments, authenticate before appending, append in timestamp order, evict old `SourceBuffer` ranges, and cancel requests on seek, unmount, lock, logout, or loss of visibility.
5. Keep a strict memory budget for ciphertext, decrypted fragment buffers, and `SourceBuffer` content. A fragment crossing a 1 MiB crypto chunk may require fetching and authenticating that full chunk, but it must not cause a full-file fetch.
6. Add generated fixture tests for playback start, seek to nonzero positions, duration, audio/video synchronization, encrypted chunk boundaries, tampering, range failure, lock revocation, and buffer eviction. Run a manual matrix on Android Chrome, current Chrome/Firefox/Edge desktop, iOS Safari, and installed iOS PWA mode. Record exact browser and OS versions.

An isolated 2026-10-23 feasibility check added a strict fMP4 box inspector and confirmed that the local FFmpeg build can remux a small synthetic H.264/AAC MP4 into a structurally fragmented output. This is only the first format check; it has no production upload or MediaSource playback path. See [v2 plan](VIDEO_SEGMENTED_V2_PLAN.md).

## Compatibility result

No compatible pipeline exists today. Existing optimized MP4 records must be treated as **download-only ciphertext** until the above format is implemented. They cannot be migrated server-side because the server must not decrypt private video. A client-side, owner-unlocked re-encode and re-upload migration is required for each existing video after the fMP4 format is available.

## Storage constraint

The configured Cloudinary Free account reported a raw-object limit of **10,485,760 bytes** in a live Usage API check on 2026-10-23. That independently blocks the PRD's single encrypted video object near 100 MB. Fragmenting the MP4 internally does not remove the account cap because the current encryption contract stores one Cloudinary object per file. The approved new-video design needs a versioned multi-object manifest, individually bounded encrypted objects, durable inventory, atomic ready transition, range-authorized segment reads, MSE playback, download reassembly, and verified deletion/recovery. The current upload and player do none of these. Existing videos stay download-only until owner-unlocked client migration is implemented and tested.

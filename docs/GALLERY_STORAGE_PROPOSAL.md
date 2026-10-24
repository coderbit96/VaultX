# Gallery storage change deferred

**Status: deferred by owner on 2026-10-22; not implemented.** The owner chose to keep the current storage layout. The current photo grid reads existing ready ciphertext in `vaultx/ciphertext/`. It creates no new Cloudinary objects. The current owner account, credentials, Atlas cluster, collections, data, production variables and existing assets stay as they are.

## Why a new layout is needed

The requested gallery needs separately encrypted photo/video thumbnails and bounded, seekable encrypted video. Existing uploads store one ordinary fast-start MP4 in one raw Cloudinary object. The observed account raw-object cap is about 10 MiB, while the product target permits encrypted videos below 100 MB. The existing MP4 has no authenticated fragment/time index, so a browser cannot seek by decrypting only the needed ranges. See [the video blocker](VIDEO_STREAMING_BLOCKER.md) and [Cloudinary feasibility record](CLOUDINARY_FEASIBILITY.md).

## Proposed change

1. Keep every existing asset and database record untouched. New gallery assets use opaque IDs beneath `vaultx/gallery/`: `photos/`, `thumbnails/`, and `video-segments/`. All remain `raw/authenticated`, uploaded only as locally encrypted ciphertext with overwrite disabled. No new account, API key, secret, Atlas cluster, or Cloudinary transformation is needed.
2. Extend the existing `files` and `uploadJobs` documents with a versioned inventory of every associated Cloudinary object and an authenticated media index. Keep legacy single-object files readable. Use existing owner authorization and ciphertext range gateway for every new object. No browser request may supply a Cloudinary public ID.
3. Generate thumbnails locally, encrypt them with distinct keys, verify each provider object identity, restricted mode and actual stored bytes, then commit the file ready only when the complete inventory is present. Cancellation, deletion and reconciliation must handle every object before reporting completion.
4. Produce local H.264/AAC fragmented MP4 with bounded segments and an authenticated time/byte index. Encrypt and upload each segment separately under the observed per-object cap, enforce the combined encrypted video cap strictly below 100,000,000 bytes, and feed decrypted fragments to MediaSource in bounded memory. Unsupported browsers remain download-only and do not pass the playback gate.
5. Use only synthetic disposable files for provider and browser tests. Require anonymous delivery denial, real 206 ranges, seek/audio checks on supported devices, lock revocation, and verified recursive deletion before any release claim.

This would change the storage layout for **new** gallery assets and expand existing file/job metadata. The owner has chosen to keep the current layout, so these changes must not be implemented. A plan upgrade is an alternative to multi-object storage, but still requires the fragmented MP4 and browser playback work; no plan or billing change is proposed here. The requested complete, seekable video gallery and separately stored thumbnails remain **BLOCKED** under the current choice.

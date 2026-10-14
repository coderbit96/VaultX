# VaultX — Product Requirements Document (PRD)

**Product:** VaultX — My Personal Private Cloud  
**Document:** `prd.md`  
**Version:** 1.0  
**Date:** 2026-10-13  
**Status:** Implementation-ready product specification  
**Primary platform:** Installable Progressive Web App (PWA)  
**Audience:** A single owner (private/personal use only)

---

## 1. Product overview

VaultX is a private, single-owner digital vault for securely storing, organizing, previewing, streaming, downloading, and permanently deleting personal photos, videos, audio files, PDFs, documents, and other files.

VaultX is built with **Next.js (App Router + TypeScript)**, **MongoDB Atlas** for metadata, and **Cloudinary** for the stored file objects. It must be installable on supported Android, iOS, and desktop browsers as a PWA, with a mobile-first interface.

The differentiating workflow is **automatic media optimization before permanent storage**:

- Images are compressed/converted to a **strict final stored-object limit of less than 1,000,000 bytes (1 MB)**.
- Videos are compressed/transcoded to a **strict final stored-object limit of less than 100,000,000 bytes (100 MB)**.
- Stored photos and videos can be **previewed/played and downloaded** by the owner whenever the user is authenticated and the relevant services/network are available.
- File or folder deletion must coordinate removal of both **Cloudinary objects and MongoDB records**, with recovery for partial failures.

VaultX is **not** a public cloud-drive product. There is no public registration, multi-user workspace, QR sharing, guest access, shared folders, or public media feed.

### 1.1 Product statement

> A private, installable personal vault that saves storage space automatically, keeps personal media easy to access, and deletes data reliably when the owner chooses.

### 1.2 Guiding principles

1. **Single-owner by design:** Only the configured owner may access the app and its contents.
2. **Privacy first:** Protect secret file contents, metadata, credentials, and access routes.
3. **Storage-efficient:** Never silently store an image/video that violates the configured size threshold.
4. **Reliable retrieval:** Successfully stored media must remain accessible in the app and downloadable in its stored optimized format.
5. **Deletion integrity:** A deleted file must not become an orphaned Cloudinary object or a dangling active MongoDB file record.
6. **Understandable UX:** Clearly show upload, optimization, storage, error, and deletion states.
7. **Realistic guarantees:** Do not claim perfect compression quality, unrestricted free storage, offline cloud access, or instant erasure of provider backups/caches.

---

## 2. Goals and non-goals

### 2.1 Goals

- Provide an installable, responsive, personal Next.js PWA.
- Allow one owner to authenticate using a strong password and supported device authentication.
- Support PIN convenience unlock with appropriate safeguards.
- Accept images, videos, audio, PDFs, Office documents, archives, and common file formats.
- Support folder and subfolder management (create, rename, move, browse, delete).
- Automatically optimize images and videos **before final storage**, subject to strict size thresholds.
- Enable image preview, video playback/seeking, audio playback, PDF viewing, and authenticated downloads.
- Save file/folder metadata in MongoDB and private file data in Cloudinary.
- Provide search, filters, sort, favorites (optional v1), storage usage, and upload status.
- Implement durable, retryable, recursive, permanent deletion.
- Ensure that the owner can reauthenticate on another device and reach stored cloud files.
- Preserve original user-facing filenames in metadata, while downloads use an extension matching the stored format.

### 2.2 Out of scope

- Public account signup or additional owner accounts.
- QR codes, share links, guest browsing, folder sharing, invitations, or third-party access.
- Publicly indexed files, social features, comments, or collaboration.
- A paid subscription or billing system.
- Automatic preservation of original high-resolution/uncompressed media in the default policy.
- Guaranteed lossless quality or successful compression for every possible image/video.
- A claim that cloud-hosted media is available during provider outages or without a network connection.
- Native Android/iOS apps in v1 (the deliverable is a PWA).

---

## 3. User and roles

### 3.1 Owner (only role)

The application has **one preprovisioned owner account**. Account creation is a protected administrative bootstrap operation, not a public page.

The owner can:

- Unlock and lock VaultX.
- Upload, optimize, browse, preview, play, and download files.
- Create and organize folders and subfolders.
- Search files and inspect storage consumption.
- Delete individual files and complete folder trees.
- Manage password, PIN, trusted devices/passkeys, and sessions.
- Check pending/failed upload and deletion jobs.

### 3.2 Account provisioning

- Initial owner is created with a one-time secure setup command or protected deployment bootstrap flow.
- Public `/signup` and public account-creation APIs do not exist.
- Strong password is required; save only a modern password hash (e.g. Argon2id) with secure parameters.
- Deployment secrets (MongoDB URI, Cloudinary credentials, auth signing secrets) remain server-side and are never exposed through `NEXT_PUBLIC_*` variables.
- If initial provisioning is already complete, bootstrap must refuse creating a second account.

---

## 4. Supported content and storage policy

### 4.1 Supported file types

| Category | Examples | Preview requirements | Size optimization |
|---|---|---|---|
| Images | JPEG, PNG, WebP, HEIC/HEIF where decodable, GIF | Gallery and fullscreen viewing | Yes; only supported still-image types. Animate GIF handling separately. |
| Videos | MP4, MOV, WebM, selected device camera formats | In-app video player | Yes; produce compatible MP4 where possible |
| Audio | MP3, M4A, WAV, OGG | In-app audio player | Not mandatory in v1 |
| Documents | PDF, TXT, DOCX, XLSX, PPTX | PDF/text preview; download others | Do not modify by default |
| Archives/other | ZIP, RAR, misc. files | Metadata/download | Do not modify by default |

Unknown or unsupported formats may be accepted as **download-only** if security checks and Cloudinary/account limits permit. Do not attempt unsafe inline rendering. Validate actual MIME/file signatures, not just extensions.

### 4.2 Hard optimization thresholds

Use **decimal bytes**, so threshold checks are unambiguous:

| Media | Required final Cloudinary object size | Preferred target (headroom) |
|---|---:|---:|
| Image | `< 1,000,000 bytes` | `≤ 950,000 bytes` |
| Video | `< 100,000,000 bytes` | `≤ 95,000,000 bytes` |

**Important:** These limits are checked against the **actual uploaded/stored object size**, including any encryption framing overhead, not merely the compressed plaintext size. If using end-to-end encryption, the optimization worker must reserve space for the encrypted container/header/tag overhead.

- A 10 MB source photo must be processed automatically and uploaded **only if** the output meets the 1 MB limit.
- A 500 MB source video must be processed automatically and uploaded **only if** the output meets the 100 MB limit.
- If compression at the allowed minimum quality/resolution cannot satisfy the limit, the app must **not** claim success or store an oversized final asset. Offer lower-quality settings (within allowed limits) or explain that upload cannot proceed.
- Never silently replace animated images with a still frame without explicit consent.
- Expose output dimensions, codec/format, resulting size, and estimated quality impact before completion where helpful.

### 4.3 Original-file retention

**Default: optimized-only.** After a verified successful upload, Cloudinary retains the **optimized output only** for images/videos. The original large file is not permanently stored by VaultX.

Consequences:

- Downloading returns the **stored optimized file**, not the original full-quality source.
- Filename extensions must match the optimized format (e.g. `holiday.webp`, `clip.mp4`).
- The UI must visibly disclose this behavior before first upload.
- Originals must not be sent to a public delivery endpoint or retained in app-controlled temporary storage after successful processing.

Optional future enhancement: opt-in original retention, which would intentionally bypass the optimized-only storage policy and incur additional storage costs. **Do not implement this in v1.**

---

## 5. Functional requirements

Priorities: **P0** must ship; **P1** important follow-up; **P2** optional future enhancement.

### 5.1 Authentication and vault lock

| ID | Priority | Requirement | Acceptance criterion |
|---|---|---|---|
| AUTH-01 | P0 | Single owner account | No public signup, secondary accounts, or anonymous media access |
| AUTH-02 | P0 | Strong password login | Bad credentials do not disclose whether an account exists; rate limits apply |
| AUTH-03 | P0 | Secure sessions | HttpOnly, Secure, SameSite cookies; idle/absolute expiration; logout invalidates session |
| AUTH-04 | P0 | Lock on launch | App opens to lock/auth screen rather than exposing previously viewed private content |
| AUTH-05 | P0 | Automatic lock | Configurable inactivity and app background re-entry lock, with platform limitations explained |
| AUTH-06 | P1 | Six-digit PIN convenience unlock | Rate-limited, bound to previously authenticated trusted device/session; not used alone to derive long-term encryption keys |
| AUTH-07 | P1 | Fingerprint/Face ID via WebAuthn | Supported platform authenticators are offered; password fallback always available |
| AUTH-08 | P0 | Authenticated API authorization | All file/folder/media/deletion endpoints verify owner server-side |
| AUTH-09 | P1 | Session/device management | Owner can invalidate trusted device sessions |

**Biometric limitation:** WebAuthn does not expose fingerprint/face data to the website. A successful platform authentication proves possession/user verification; it does not automatically unlock a client-encrypted file key. If cryptographic keys have been cleared from memory, require the master secret or an explicitly supported and securely designed device-bound key-unwrapping mechanism (such as a carefully implemented WebAuthn PRF workflow where available).

### 5.2 Folder management

| ID | Priority | Requirement | Acceptance criterion |
|---|---|---|---|
| FOLDER-01 | P0 | Root folder and unlimited logical nesting | Owner can create nested folders up to practical UI/database safety limits |
| FOLDER-02 | P0 | Rename folders | Rename updates MongoDB metadata without breaking file references |
| FOLDER-03 | P0 | Move folders/files | Prevent cycles (moving a folder into itself/descendant); preserve ownership |
| FOLDER-04 | P0 | Browse folders | Breadcrumbs and back navigation work on desktop/mobile |
| FOLDER-05 | P0 | Recursive folder deletion | All descendants and objects are included; deletion never affects sibling folder assets |
| FOLDER-06 | P1 | Folder search/filter | Search matches the correct owner and excludes deleting assets |

### 5.3 File upload and lifecycle

| ID | Priority | Requirement | Acceptance criterion |
|---|---|---|---|
| UP-01 | P0 | File selection | Single/multiple selection; drag-and-drop on desktop; mobile file picker |
| UP-02 | P0 | Type inspection | File signature and MIME checks; safe handling of unsupported file types |
| UP-03 | P0 | Automatic image optimization | See Section 6; final stored image object <1 MB |
| UP-04 | P0 | Automatic video optimization | See Section 7; final stored video object <100 MB |
| UP-05 | P0 | Upload state | UI shows `queued`, `optimizing`, `uploading`, `verifying`, `ready`, `failed` |
| UP-06 | P0 | No phantom files | A file becomes ready only after Cloudinary confirmation and MongoDB commit |
| UP-07 | P0 | Retry behavior | Interrupted/failing uploads can retry or clean up partial assets; no duplicate active records |
| UP-08 | P0 | Metadata | Store owner, folder, display/stored filenames, MIME, byte sizes, dimensions/duration, Cloudinary ID/type, timestamps, state |
| UP-09 | P1 | Resumable uploads | Large transfers use chunked/resumable upload where supported |
| UP-10 | P0 | File size validation | Server confirms output size; frontend-only validation is insufficient |
| UP-11 | P0 | Upload cancellation | Cancel safely, with temporary object cleanup and status update |

### 5.4 Preview, playback and downloads

| ID | Priority | Requirement | Acceptance criterion |
|---|---|---|---|
| MEDIA-01 | P0 | Image gallery | Thumbnails/grid; fullscreen viewing of every successfully stored supported image |
| MEDIA-02 | P0 | Video playback | HTML5-compatible MP4 playback with pause, seek, volume, fullscreen |
| MEDIA-03 | P0 | Audio playback | Supported audio formats play in authenticated view |
| MEDIA-04 | P0 | PDFs | PDFs preview safely and can be downloaded |
| MEDIA-05 | P0 | Downloads | Every stored file has a download action returning its **stored** bytes |
| MEDIA-06 | P0 | Secure retrieval | No public media URLs or unauthenticated originals/transformations |
| MEDIA-07 | P0 | Expiring access | Access credentials are refreshed safely so expiration does not permanently break stored files |
| MEDIA-08 | P0 | Range/stream support | Video seeks work using authenticated byte-range requests or a supported signed-delivery design |
| MEDIA-09 | P1 | Offline selected media | Only explicitly downloaded encrypted items are available offline; encrypted local storage is required |

**Availability expectation:** "Always accessible" means persisted and retrievable while the owner's authentication, internet, Cloudinary, MongoDB, and hosting services are operational. A PWA is not a guarantee of uninterrupted cloud access. Consider an independent encrypted backup/export as a P1 safety feature.

### 5.5 Search and organization

- **P0:** Search by filename across the owner's files.
- **P0:** Sort by date added, name, file type, and stored size.
- **P0:** Filter image/video/audio/document categories.
- **P0:** Display storage totals based on successfully stored Cloudinary-backed files.
- **P1:** Favorites and recent files.
- **P1:** Duplicate detection using client-computed hashes while preserving privacy.

### 5.6 Permanent deletion

| ID | Priority | Requirement | Acceptance criterion |
|---|---|---|---|
| DEL-01 | P0 | Delete a single file | Cloudinary asset and MongoDB file record are both removed before reporting completed |
| DEL-02 | P0 | Delete folder recursively | All descendant files/Cloudinary assets/subfolders are enumerated and removed |
| DEL-03 | P0 | Hide deletion-in-progress | `deleting` items disappear from normal listing and cannot be downloaded |
| DEL-04 | P0 | Durable deletion jobs | Crash or network timeout does not lose track of Cloudinary objects pending deletion |
| DEL-05 | P0 | Idempotent delete | Repeating a request cannot remove another file or corrupt state |
| DEL-06 | P0 | Retry failures | Transient errors are retried with backoff and displayed as pending/failed until resolved |
| DEL-07 | P0 | No false completion | UI never reports permanent deletion if required service operations have not been confirmed |
| DEL-08 | P0 | Clean app caches | Remove VaultX-managed offline encrypted objects and thumbnails on deletion |
| DEL-09 | P0 | Preserve unrelated files | Deleting one folder never affects assets outside its authorized subtree |
| DEL-10 | P1 | Recovery/diagnostics | Owner can inspect and retry failed deletion jobs without raw credential exposure |

**Deletion reality:** MongoDB and Cloudinary do not share one atomic transaction. Cloudinary CDN invalidation, account backups, provider retention, third-party screenshots, browser downloads, and user-controlled copies may survive longer. Configure provider backup/retention settings and describe the true deletion semantics in the app. VaultX must at minimum delete active Cloudinary objects and MongoDB file/folder records, and invalidate its own managed caches.

---

## 6. Image optimization specification

### 6.1 Pipeline

1. Receive selected image locally; validate type and decode safely.
2. Read dimensions/orientation; maintain aspect ratio.
3. Handle EXIF orientation and strip unnecessary metadata for privacy.
4. Preserve transparency when appropriate (e.g. WebP).
5. For still images, attempt modern broadly supported encoding (prefer WebP; JPEG fallback).
6. Iteratively adjust encoding quality and, if needed, dimensions to meet a target of **≤950,000 bytes**, reserving encryption overhead if enabled.
7. Stop when the **final encoded encrypted object** will be **<1,000,000 bytes**.
8. Show a preview and file-size result; warn about clearly material loss of image quality.
9. Upload verified result privately to Cloudinary.
10. Record stored MIME, byte size, dimensions and Cloudinary asset identifier in MongoDB.

### 6.2 Quality boundaries

- Start with original dimensions up to an implementation-configured cap; reduce progressively, not immediately to an unnecessarily tiny image.
- Establish testable minimum output resolution/quality thresholds. If satisfying `<1 MB` would violate the threshold, fail with an understandable option to retry at lower quality, rather than uploading oversized content.
- Honor transparency where feasible.
- Do not flatten animated GIF/WebP to still images silently; either implement animated optimization that respects motion or mark unsupported and give a clear error.
- HEIC/HEIF support is conditional on decoder availability; provide an explicit unsupported fallback.
- Preserve the optimized version only in persistent storage.

### 6.3 Example acceptance tests

- A 10 MB JPEG is optimized automatically; if resulting quality satisfies configured minimum, the persisted object is `<1,000,000 bytes` and it previews/downloads.
- A low-resolution 200 KB JPEG is not unnecessarily upscaled or visibly degraded.
- A transparent PNG stays transparent when converted to a supported format.
- An image that cannot meet limit and quality floor does not become a `ready` file.
- Corrupt input produces an error; no partial permanent object or active file record is left behind.

---

## 7. Video optimization specification

### 7.1 Pipeline

1. Inspect video size, duration, resolution, codec, audio tracks, and rotation.
2. Compute a target bitrate budget from duration and allowed byte size, reserving audio/container/encryption overhead.
3. Encode to broadly compatible **MP4 (H.264 video + AAC audio)** where input and available encoding tools permit.
4. Use configurable presets, e.g. 1080p → 720p → 480p → 360p, reducing bitrate as needed.
5. Validate final duration, decodability, audio presence, output size, and representative playback/seek behavior.
6. Only finalize upload when encrypted/stored object is **<100,000,000 bytes**; prefer ≤95,000,000 bytes.
7. Store output metadata and mark the asset ready only after Cloudinary and MongoDB succeed.

### 7.2 Encoding runtime

- Very large video encoding may be expensive or unsupported in mobile browsers.
- Use a **dedicated background processing worker/service** (not a long-running Next.js request or ordinary Vercel serverless function) when browser-local encoding is not reliable.
- If using a server-side worker, it temporarily receives plaintext video. This is **not full end-to-end encryption** for the processing step and must be explicitly disclosed.
- For a fully client-encrypted design, process the video locally on the user's device before encrypting/uploading; if it cannot be processed, fail safely rather than secretly sending the raw secret video to a worker.
- The v1 privacy-first default is **local-first media optimization** with worker usage only when explicitly enabled/consented to. Worker mode is excluded from v1 unless its privacy model is implemented and documented.
- Allow progress, cancellation, transient failure and retry.

### 7.3 Video feasibility constraints

Not every large/long/complex video can be made `<100 MB` at watchable quality. Target bitrate is bounded by duration. Long recordings may require unacceptable compression. VaultX must not claim that high quality is guaranteed.

### 7.4 Example acceptance tests

- A suitable 500 MB video can be transcoded and permanently stored at `<100,000,000 bytes`; seek, play and download all work.
- A too-long video that cannot meet the quality floor is rejected with actionable messaging.
- An interrupted transcode/upload can be cancelled without leaving an active incomplete file.
- The generated MP4 contains synchronized audio where the input has audio.
- Video streaming supports seek/range requests without requiring entire encrypted video to be loaded in browser RAM.

---

## 8. Security and encryption model

VaultX is designed to hold sensitive personal content. **Client-side encryption before permanent upload is a core privacy requirement**; it must be implemented and tested before real secret files are stored.

### 8.1 Default privacy model

1. Compress media on-device where supported.
2. Encrypt the optimized file locally using **AES-256-GCM** with unique file keys and nonces.
3. Store ciphertext in **private Cloudinary assets** (prefer an authenticated, restricted raw-asset strategy, verified against current Cloudinary account capabilities).
4. Save only ciphertext references and necessary metadata in MongoDB; encrypt sensitive filenames/metadata where practical.
5. On preview/download, authenticate the owner, fetch the encrypted bytes, and decrypt on the owner's device.
6. Do **not** expose Cloudinary API secrets, original plaintext files, or vault keys to the browser bundle or logs.

Because Cloudinary receives ciphertext, do **not** rely on Cloudinary image transformations/thumbnails or video transcoding of permanently stored encrypted assets. Generate encrypted thumbnail variants locally if needed. Signed Cloudinary URLs without client-side encryption restrict delivery but do not create zero-knowledge storage.

### 8.2 Master key and recovery

- Use a randomly generated vault key to protect per-file keys.
- Derive a password-unwrapping key using a reviewed password-based KDF (e.g. Argon2id with tuned parameters) to unlock the vault key.
- Keep plaintext keys in volatile memory for the shortest practical time; clear on explicit lock/logout and when possible on inactivity.
- Do not rely on a 6-digit PIN as the sole secret from which the vault key is derived.
- Provide an owner-held recovery key or encrypted recovery backup with clear warnings: losing all valid unlock/recovery keys may cause permanent loss of access to encrypted files.
- Key management is security-critical: do not invent novel cryptographic algorithms.

### 8.3 Authentication and authorization

- All API routes check the authenticated owner; never trust owner IDs supplied by the browser.
- Protect app routes against CSRF where relevant, XSS, injection, credential stuffing, broken access controls, and insecure direct object references.
- Use strict security headers including CSP, HSTS, `Cache-Control: no-store` on private responses, and `Referrer-Policy: no-referrer`.
- Do not load analytics or unrelated third-party scripts on secret-bearing views.
- Never persist decrypted files in a publicly readable service-worker cache.
- Secrets remain server-side. Cloudinary upload signing occurs in authenticated server routes; enforce signed upload preset/resource constraints.
- Server must verify bytes/type/owner metadata before confirming any uploaded asset. Treat client-provided file size claims as untrusted.

### 8.4 File delivery strategy

- Cloudinary assets are **never** available through unauthenticated public links.
- Use authenticated server-mediated access and short-lived restricted delivery when supported.
- With end-to-end encrypted objects, the browser receives ciphertext and decrypts locally.
- Support safe byte-range access for large encrypted videos: encrypt per chunk with authenticated metadata and unique nonce, and decrypt only needed chunks client-side.
- Validate cloud provider capabilities and pricing before finalizing the delivery pattern. A private authenticated proxy may introduce bandwidth costs.

---

## 9. MongoDB data model (proposed)

Use **Mongoose** or a comparable typed MongoDB access layer. The following are logical collections; final indexes/field shapes are implementation decisions.

### 9.1 `owners`

```ts
{
  _id: ObjectId;
  username: string;                 // unique; only one owner
  passwordHash: string;
  initializedAt: Date;
  settings: {
    autoLockMinutes: number;
    requireLockOnOpen: boolean;
  };
}
```

### 9.2 `folders`

```ts
{
  _id: ObjectId;
  ownerId: ObjectId;
  parentFolderId: ObjectId | null;
  nameEncrypted: string;            // or name + separate metadata encryption scheme
  status: 'active' | 'deleting';
  createdAt: Date;
  updatedAt: Date;
}
```

### 9.3 `files`

```ts
{
  _id: ObjectId;
  ownerId: ObjectId;
  folderId: ObjectId | null;
  nameEncrypted: string;
  extension: string;
  category: 'image' | 'video' | 'audio' | 'document' | 'other';
  mimeType: string;
  sourceSizeBytes?: number;
  storedSizeBytes: number;
  width?: number;
  height?: number;
  durationSeconds?: number;
  cloudinary: {
    publicId: string;
    assetId?: string;
    resourceType: 'image' | 'video' | 'raw';
    deliveryType: string;
    format?: string;
    version?: number;
  };
  encryptedFileKey: string;
  encryptionManifest: object;       // contains algorithm/chunk metadata, no plaintext key
  status: 'queued' | 'optimizing' | 'uploading' | 'verifying' | 'ready' | 'deleting' | 'failed';
  createdAt: Date;
  updatedAt: Date;
}
```

### 9.4 `deletionJobs`

```ts
{
  _id: ObjectId;
  ownerId: ObjectId;
  targetType: 'file' | 'folder';
  targetId: ObjectId;
  cloudAssets: Array<{
    publicId: string;
    assetId?: string;
    resourceType: string;
    deliveryType: string;
    completed: boolean;
  }>;
  status: 'pending' | 'running' | 'retrying' | 'failed' | 'completed';
  attempts: number;
  lastErrorCode?: string;
  nextAttemptAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}
```

### 9.5 `uploadJobs`, `sessions`, `deviceCredentials`

Store resumable-upload state, session records, and WebAuthn credential metadata in dedicated collections as required. Never store biometric templates or client plaintext encryption keys.

### 9.6 Required indexes

- `folders`: `{ ownerId: 1, parentFolderId: 1, status: 1 }`
- `files`: `{ ownerId: 1, folderId: 1, status: 1 }`
- `files`: `{ ownerId: 1, category: 1, createdAt: -1 }`
- `deletionJobs`: `{ status: 1, nextAttemptAt: 1 }`
- `owners.username`: unique

Encrypted names require a **separate search design**: either search client-side over a locally decrypted metadata index, or maintain carefully designed privacy-preserving search tokens. Do not promise a standard database text index can search ciphertext.

---

## 10. Cloudinary integration

### 10.1 Storage rules

- Use a Cloudinary account controlled by the owner.
- Keep permanent assets restricted/private; never upload personal content into ordinary public delivery with predictable asset URLs.
- For client-encrypted data, upload ciphertext as binary/raw assets or an equivalent verified authenticated delivery configuration.
- Use a deterministic application namespace for management, e.g. `vaultx/owner-id/opaque-file-id`, but **authorization must never depend only on this path**.
- Store exact asset identifiers, resource type, delivery type and format in MongoDB for retrieval/deletion.
- Enforce least-privilege upload signing and server-side verification of completed uploads.
- Validate Cloudinary plan limits for maximum object size, monthly storage, processing, video transformation quotas, bandwidth and delivery configuration. No unlimited-free-storage claim.

### 10.2 Data consistency

MongoDB is the authoritative index of intended application files; Cloudinary is the actual object store. An object is marked `ready` only when:

1. Its final stored bytes are confirmed within limits.
2. Cloudinary confirms its asset exists and is restricted as intended.
3. Encryption manifest and required decryption material are correctly recorded (in wrapped form).
4. MongoDB record commits successfully.

For orphan prevention after upload failure, keep a durable upload-job/object reference and run reconciliation/cleanup.

---

## 11. Permanent deletion design

### 11.1 Single-file delete (required state machine)

`ready → deleting → remote-delete-confirmed → metadata-removed → completed`

1. Authenticate and authorize owner.
2. Start a durable deletion job containing **all** Cloudinary object identifiers for the file (main object, encrypted thumbnail variants, etc.).
3. Mark the file `deleting` and block new reads/downloads.
4. Delete each Cloudinary object using the appropriate `resource_type`, `type`, and identifier; request CDN invalidation where applicable.
5. Verify deletion or treat provider-reported "already absent" as success.
6. Remove associated file documents and references from MongoDB only after remote objects are confirmed removed.
7. Remove VaultX-managed cached local copies.
8. Mark and eventually retire the deletion job after success.

Use idempotent operations and exponential backoff for transient failures. Do not trust a single request to complete all steps without a worker/reconciler.

### 11.2 Folder delete

1. Authenticate owner and identify selected subtree using `ownerId` and parent references.
2. Atomically mark/fence the subtree as deleting; prohibit uploads/moves into it during deletion.
3. Enumerate **all descendant folders and their files**. Persist the complete list of Cloudinary object references before deleting any MongoDB records.
4. Process Cloudinary deletions in safe batches with concurrency/rate limits.
5. On successful cloud removals, remove all contained file records and then folder records bottom-up.
6. If a failure occurs, retain job state and retry; never claim completion early.
7. Confirm that sibling/unrelated folders and Cloudinary objects were untouched.

### 11.3 Backups and cache caveat

"Permanently delete" applies to **active VaultX-managed MongoDB records and Cloudinary assets**, including generated variants and app caches. Provider backups, browser downloads, third-party caches, logs, and CDN invalidation propagation are not fully controlled by VaultX. Configure backup policies and communicate any retention limitations honestly.

---

## 12. Pages and mobile-first UX

### 12.1 Route map

| Route | Screen | Authentication |
|---|---|---|
| `/` | Redirect to unlock/dashboard | Conditional |
| `/unlock` | Password / PIN / WebAuthn unlock | Public screen; rate-limited |
| `/vault` | Dashboard, storage usage, recent files | Owner required |
| `/vault/files` | File and folder explorer | Owner required |
| `/vault/folders/[id]` | Folder view | Owner required |
| `/vault/gallery` | Photos and videos | Owner required |
| `/vault/files/[id]` | Secure file viewer | Owner required |
| `/vault/uploads` | Upload queue/status | Owner required |
| `/vault/settings` | App, security and storage settings | Owner required |
| `/vault/deletions` | Pending/failed deletion jobs | Owner required |

### 12.2 Navigation

Mobile bottom navigation:

1. Home
2. Files
3. Gallery
4. Settings

Include a prominent floating **+** button for file upload and folder creation. Desktop can use a responsive sidebar.

### 12.3 UI and accessibility

- Premium, uncluttered dark interface (with accessible contrast).
- Responsive from narrow phone screens to desktop.
- Clear file-type icons and video/image thumbnails.
- Upload optimization progress and remaining-stage indicators; do not invent precise estimates.
- Human-readable errors and success confirmations.
- Destructive actions require explicit confirmation with affected file count/size where available.
- Support keyboard navigation, screen readers, focus management, and reduced-motion preference.
- Gallery and preview must support full-screen controls where the browser permits.

---

## 13. PWA behavior

### 13.1 Must-have

- Valid manifest with name, short name, theme color, icons, display mode, and start URL.
- Service worker for app shell/static assets.
- Install flow suitable for supported Android/desktop browsers; clear instructions for iOS Home Screen installation where needed.
- Responsive standalone experience with correct safe-area/padding behavior.
- Online/offline indicator.
- Authentication/locking behavior tested on returning to a suspended PWA.
- Appropriate update mechanism for new app versions.

### 13.2 Offline limits

- Basic app shell may work offline.
- **Cloud-only files are not available offline** until explicitly cached/downloaded.
- Do not cache decrypted media in a service worker, Cache Storage, or unencrypted IndexedDB.
- Optional P1: owner selects files to keep offline in **encrypted IndexedDB**, subject to browser quotas/eviction; warn about limited offline guarantees.

---

## 14. API outline

All mutation/file endpoints require owner authentication, CSRF safeguards as appropriate, validation, rate limits, and consistent error responses.

| Method | Endpoint | Purpose |
|---|---|---|
| POST | `/api/auth/login` | Password sign-in |
| POST | `/api/auth/logout` | Invalidate session |
| POST | `/api/auth/lock` | Re-lock UI session |
| GET | `/api/vault/summary` | Storage totals and counters |
| GET | `/api/folders` | Root/child folder list |
| POST | `/api/folders` | Create folder |
| PATCH | `/api/folders/[id]` | Rename/move folder |
| DELETE | `/api/folders/[id]` | Queue recursive deletion |
| GET | `/api/files` | List/filter/search owner files |
| POST | `/api/uploads/init` | Create authorized upload intent |
| POST | `/api/uploads/complete` | Verify and finalize uploaded asset |
| GET | `/api/uploads/[id]` | Check upload status |
| DELETE | `/api/uploads/[id]` | Cancel upload |
| PATCH | `/api/files/[id]` | Rename/move file |
| GET | `/api/files/[id]/access` | Obtain authorized ciphertext access / stream parameters |
| GET | `/api/files/[id]/download` | Authorized encrypted download gateway if needed |
| DELETE | `/api/files/[id]` | Queue permanent deletion |
| GET | `/api/deletions` | List status of deletion jobs |
| POST | `/api/deletions/[id]/retry` | Retry failed deletion |
| GET | `/api/settings` | Read owner settings |
| PATCH | `/api/settings` | Update owner settings |

**Note:** Never use a bare `fileId` as authorization; every file access must check ownership and allowed status. For client-decrypted media, the frontend obtains ciphertext and transforms it locally for playback/download.

---

## 15. Non-functional requirements

### 15.1 Performance

- Interactive main shell should load quickly on ordinary mobile connectivity; avoid bundling video encoders on initial dashboard load.
- Dynamically import image/video processing modules only when needed.
- Virtualize large file lists and lazy-load encrypted thumbnails.
- Support streaming/chunking for large video downloads and playback to avoid memory exhaustion.
- Compression must provide cancellation and responsive UI (workers for CPU-heavy browser work).
- Measure real performance rather than guaranteeing unrealistic fixed times across hardware.

### 15.2 Reliability

- Every upload has durable state and clear retry handling.
- Every deletion has a persisted recoverable job.
- Scheduled reconciliation identifies unfinished uploads, deletion jobs and orphaned objects.
- Log operational events without raw media, filenames (if secret), passwords or encryption keys.
- Manage Cloudinary API failures, MongoDB outages, network loss, browser tab close and process restarts.

### 15.3 Security tests

- Cannot create second account or access through anonymous API requests.
- Cannot fetch encrypted objects without authenticated owner authorization.
- Cannot enumerate another asset by modifying public IDs or file IDs.
- Cannot bypass file-size enforcement by modifying client-upload metadata.
- Cannot upload malicious active content that is rendered unsafely.
- CSRF, XSS and session fixation protections are verified.
- Private media never enters a public CDN delivery mode.
- Revoked sessions fail on protected endpoints.

---

## 16. Test plan and definition of done

### 16.1 E2E user journeys

1. Fresh deployment provisions exactly one owner, signs in, locks and unlocks.
2. Owner installs PWA on an Android device and opens standalone UI.
3. Owner uploads a 10 MB image; app compresses and stores `<1 MB`, previews and downloads it.
4. Owner uploads a compressible large video; app stores `<100 MB`, plays/seeks and downloads it.
5. App rejects an image/video that cannot satisfy hard cap and quality constraint; no false-ready record appears.
6. Owner creates folders/subfolders, uploads mixed media, searches, renames and moves.
7. Owner deletes one image; Cloudinary original/variants and MongoDB file record are removed, after verified completion.
8. Owner deletes a folder with nested content; only those assets and corresponding database records are removed.
9. Simulate Cloudinary deletion failure; job retries and never falsely reports completed.
10. Simulate MongoDB failure after successful cloud deletion; reconciliation finalizes metadata removal safely.
11. Logout or lock, then attempt protected API/media access; request is denied.
12. Open vault on another authenticated device with correct cryptographic recovery/unlock flow; stored content is accessible.
13. Refresh page, suspend/reopen PWA, and interrupt an upload; app recovers or clearly marks a retryable failure.

### 16.2 Definition of done (v1)

- [ ] Single-owner provisioning and protected sessions
- [ ] Installable responsive PWA
- [ ] Password unlock and auto-lock
- [ ] Client-encrypted permanent cloud storage with documented key recovery
- [ ] MongoDB folders, metadata and searches
- [ ] Authenticated Cloudinary object delivery
- [ ] Image final object `<1,000,000 bytes` or explicit reject
- [ ] Video final object `<100,000,000 bytes` or explicit reject
- [ ] Image/video/audio/PDF preview where supported
- [ ] Every stored file is downloadable
- [ ] Recursive delete across Cloudinary and MongoDB
- [ ] Durable retryable deletion/reconciliation
- [ ] No sharing routes, QR links, public signup, or guest access
- [ ] Automated unit, integration, and E2E tests for security and failure conditions
- [ ] Clear backup, retention and service availability disclosures

**P1 milestone:** PIN and WebAuthn convenience unlock, trusted device/session management, encrypted selective offline files, recovery/export enhancements, favorites, and enhanced resumable transfer behavior. If biometric/PIN is required before first release for personal use, promote these items to P0 after foundational encryption/key management is secure.

---

## 17. Development phases and delivery order

### Phase 1 — Foundation

- Initialize Next.js App Router, TypeScript, Tailwind CSS, shadcn/ui.
- Configure lint, test, environment validation, deployment.
- Connect MongoDB; configure Cloudinary SDK with server-only secrets.
- Add PWA manifest, shell and responsive navigation.

### Phase 2 — Single-owner security

- Secure owner bootstrap, password login, session management and lock screen.
- Define encryption/key-wrapping architecture and backup/recovery.
- Establish owner-only authorization middleware and tests.

### Phase 3 — Folders and encrypted uploads

- Folder tree, file metadata, uploads and durable upload state.
- Client-side encryption before Cloudinary persistence.
- Private ciphertext access paths and database state validation.

### Phase 4 — Optimization engine

- Image compression/resizing/format conversion and strict size checks.
- Video bitrate planning/transcoding and strict size checks.
- Upload progress, quality failure states, cancellation/retry.

### Phase 5 — Gallery, preview, playback, downloads

- Gallery, image viewer, video streaming/seek, audio/PDF viewing.
- Secure download flow and filename/format mapping.
- Responsive desktop/mobile experience.

### Phase 6 — Permanent deletion and recovery

- Deletion jobs, recursive subtree enumeration, Cloudinary delete verification.
- MongoDB cleanup, offline-cache cleanup, retries, reconciliation.
- Failure simulation and audit test coverage.

### Phase 7 — Device authentication and polish

- PIN/WebAuthn convenience unlock with secure key lifecycle.
- Optional encrypted offline media and improved install UX.
- Accessibility, mobile-device testing, performance, secure deployment review.

---

## 18. Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Lossy compression damages content | Poor media quality | Minimum quality threshold, preview, explicit failure rather than silent degradation |
| Extremely long videos cannot fit 100 MB | Upload rejected | Compute achievable bitrate, present options; never fake success |
| Mobile browser cannot transcode format | Upload blocked | Browser feature detection and format-specific errors; future optional dedicated secure worker |
| Large video decryption exhausts RAM | Playback failures | Chunk encryption and range-streamed client decryption |
| Cloudinary free plan/quota exhaustion | Upload or retrieval failure | Quota monitoring, error handling, plan limits, independent encrypted backup |
| Cloudinary+MongoDB deletion partial failure | Orphaned objects or stale metadata | Durable deletion jobs, verified idempotent retries, reconciliation |
| Password/recovery key lost | Owner cannot decrypt vault | Recovery key with explicit offline backup instructions |
| PIN/WebAuthn used without key-wrapping design | Misleading unlock security | Password fallback and documented session/key lifecycle |
| Service worker caches sensitive decrypted media | Privacy breach | Disable persistent plaintext caching; encrypted offline cache only |
| Public Cloudinary delivery by accident | Sensitive data exposure | Restrict account/upload/delivery configuration, test URL access anonymously |
| Unexpected backup retention | Not immediately erased everywhere | Disclose and configure provider retention, invalidate CDN caches |

---

## 19. Project structure (suggested)

```text
vaultx/
├── app/
│   ├── (auth)/unlock/
│   ├── (vault)/vault/
│   │   ├── files/
│   │   ├── folders/[id]/
│   │   ├── gallery/
│   │   ├── uploads/
│   │   ├── deletions/
│   │   └── settings/
│   ├── api/
│   │   ├── auth/
│   │   ├── files/
│   │   ├── folders/
│   │   ├── uploads/
│   │   ├── deletions/
│   │   └── settings/
│   └── manifest.ts
├── components/
│   ├── auth/
│   ├── vault/
│   ├── gallery/
│   ├── upload/
│   └── ui/
├── lib/
│   ├── auth/
│   ├── crypto/
│   ├── database/
│   ├── cloudinary/
│   ├── compression/
│   ├── deletion/
│   ├── uploads/
│   └── validation/
├── models/
├── workers/
│   ├── image-compression.worker.ts
│   └── video-compression.worker.ts
├── public/
│   └── icons/
├── scripts/
│   ├── bootstrap-owner.ts
│   └── reconcile-storage.ts
├── tests/
│   ├── unit/
│   ├── integration/
│   └── e2e/
├── .env.example
├── package.json
└── prd.md
```

---

## 20. Configuration and deployment checklist

Use a documented `.env.example` for **names only**, without live credentials:

```dotenv
MONGODB_URI=
MONGODB_DB_NAME=vaultx
CLOUDINARY_CLOUD_NAME=
CLOUDINARY_API_KEY=
CLOUDINARY_API_SECRET=
AUTH_SECRET=
NEXT_PUBLIC_APP_URL=
```

Deployment requirements:

- Production HTTPS for PWA installation/WebAuthn.
- Restrictive security headers.
- MongoDB Atlas network and credential controls.
- Cloudinary delivery restrictions verified with anonymous requests.
- Error/usage monitoring without logging private content.
- Job runner/scheduler for incomplete deletions and upload reconciliation.
- Recovery-key/export guidance.
- Test deployment on Android Chrome, iOS Safari Home Screen, and desktop browsers.

---

## 21. Final product acceptance statement

**VaultX v1 is accepted only if** its single owner can install and unlock the PWA, upload and organize personal files, have supported images/videos automatically reduced below the defined *stored-object* limits without silently violating quality rules, privately view/play and download every successfully stored item, and permanently delete selected files or entire folder trees from active Cloudinary storage and MongoDB through a reliable, verifiable process.

**No external sharing functionality of any kind is part of the product.**

> **Engineering note:** This PRD specifies expected behavior and security controls; detailed cryptographic formats, encoding presets, Cloudinary delivery mechanisms, and job-runner deployment must be implemented, validated against the actual service plan, and security-tested before using the vault for irreplaceable private data.

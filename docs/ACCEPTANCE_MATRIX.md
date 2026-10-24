# VaultX PRD §16 acceptance record

This is the 2026-10-16 run record. See the [2026-10-22 full PRD audit](PRD_AUDIT.md) for current source findings, including the newer basic photo gallery, missing thumbnail upload, and missing encrypted seek playback. Results below were not silently promoted to complete acceptance.

Date: 2026-10-16. All automated media fixtures were generated for testing and contain no personal files. **PASS** means the stated journey was exercised at the stated boundary. **BLOCKED** means the complete PRD journey has not been demonstrated; passing component checks do not change that result. No physical Android/iOS device, deployed HTTPS origin, fresh owner installation, or complete browser upload/playback journey was tested in this run.

## Commands and observed results

Run these from `D:\VaultX` in the VS Code PowerShell terminal. The live commands below use configured credentials from the ignored `.env.local`; their scripts create disposable synthetic assets/databases and report cleanup. They must not be pointed at personal files. `test:e2e` requires a successful `build` first and installed Google Chrome.

| Command | Boundary | Result in this run |
| --- | --- | --- |
| `npm run lint` | Static | PASS |
| `npm run typecheck` | Static | PASS |
| `npm test` | Unit/contract, mainly mocked services | PASS: 120/120 |
| `npm run build` | Production compile | PASS |
| `npm run test:e2e` | Playwright Test, production server, Chrome | PASS: 2/2; anonymous route denial and emulated mobile public PWA shell |
| `npm run folders:ui-check` | Chrome desktop/phone emulation, isolated local MongoDB | PASS after repairing a real summary projection bug; nested folders, search, rename/move, lock |
| `npm run image:check` | Chrome synthetic local image optimizer | PASS: 9,334,257-byte JPEG → 929,896-byte optimized image; **estimated** encrypted size 930,155 bytes |
| `npm run video:check` | Chrome synthetic local transcode | PASS on standalone rerun: 49,746-byte WebM/audio → 58,732-byte MP4; estimated encrypted size 58,992 bytes; playback/seek/audio. An earlier concurrent run FAILED with `validation_failed`; this check is not proven stable under load. |
| `npm run pwa:check` | Chrome production PWA, phone emulation | PASS: manifest, installability checks, public cache/offline shell; no real phone or deployed HTTPS |
| `npm run offline:check` | Chrome synthetic offline ciphertext | PASS: unlock, download, lock, deletion event |
| `npm run auth:check` | Isolated Atlas synthetic owner | PASS: auth and lock flows |
| `npm run settings:check` | Isolated Atlas synthetic owner, two browser contexts | PASS: session revoke, password/key rotation and recovery |
| `npm run db:owner-race-check` | Isolated Atlas unique index | PASS: second owner rejected |
| `npm run lock:check` | Production HTTP server, isolated synthetic Atlas | PASS: private route/media denial, expiry, CSRF, rate limits, lock |
| `npm run security:bundle-check` | Built public bundle | PASS: 40 files scanned for 5 configured secret values |
| `npm run media:access-check` | Live Cloudinary, synthetic ciphertext | PASS: unsigned delivery denied; two exact signed byte ranges; object removed |
| `npm run uploads:integration-check` | Live Atlas + Cloudinary, disposable synthetic objects | PASS: small encrypted image/video/other categories, provider size confirmation and ready commit; cleanup reported |
| `npm run deletions:live-check` | Live Atlas + Cloudinary, disposable synthetic object | PASS: one file's active Cloudinary object and MongoDB record removed; repeat request idempotent; cleanup reported |
| `npm run deletions:folder-check` | Atlas temporary collections, **mock Cloudinary provider** | PASS: 71-folder subtree, file/folder removal, fencing and sibling preservation; cleanup reported |

The existing unit tests use in-memory stores/providers unless a row explicitly says Atlas or Cloudinary. Provider confirmation of a small synthetic encrypted object does **not** prove a real image/video was decoded, optimized, previewed or downloaded through the full browser UI. The image/video sizes above are local predictions; the separate live provider tests verify actual stored bytes only for small synthetic objects.

## PRD §16.1 journey matrix

| # | Journey | Result | Evidence and exact remaining gate |
| --- | --- | --- | --- |
| 1 | Fresh deployment, exactly one owner, login/lock/unlock | **BLOCKED** | `db:owner-race-check`, `auth:check`, `lock:check` pass in isolated Atlas. A fresh deployment and one continuous bootstrap → browser login → lock → unlock journey were not run; the configured owner already exists. |
| 2 | Android PWA install and standalone open | **BLOCKED** | `test:e2e` and `pwa:check` pass in Chrome emulation. Physical Android installation and standalone/resume behavior were not run. |
| 3 | 10 MB image → optimized encrypted object `<1,000,000` bytes, preview/download | **BLOCKED** | `image:check` passed with a 9.33 MB synthetic JPEG and estimated 930,155 encrypted bytes. `uploads:integration-check` passed actual provider bytes for a separate small synthetic object. The exact full browser journey and preview/download of that optimized stored image were not run. |
| 4 | Large video → encrypted object `<100,000,000` bytes, play/seek/download | **BLOCKED** | `video:check` verifies only a tiny playable local MP4 and had one failed concurrent run. The account's reported 10,485,760-byte raw-object limit blocks a single near-100 MB object. The current MP4 output is not a validated fragmented MP4 streaming format; bounded-memory encrypted seek playback remains unverified. |
| 5 | Reject bad quality/cap encode without false-ready record | **BLOCKED** | `image:check`, `video:check` and `npm test` exercise local rejection, exact byte boundaries and mocked upload failure. A continuous browser rejection plus live absence of a ready record was not run. |
| 6 | Folders, nested mixed-media uploads, search, rename and move | **BLOCKED** | `folders:ui-check` passes nested desktop/phone folder actions and client search using labeled synthetic records. Live upload integration tests create separate small category objects, not mixed media through this browser journey. |
| 7 | Delete image including all variants in Cloudinary and MongoDB | **BLOCKED** | `deletions:live-check` verifies a single synthetic encrypted object and file record. A full image plus encrypted thumbnail/variant inventory and CDN propagation were not live-tested. |
| 8 | Recursive nested folder deletion, preserving siblings | **BLOCKED** | `deletions:folder-check` verifies Atlas records and subtree boundaries with a mock provider. A live multi-object Cloudinary recursive delete was not run. |
| 9 | Simulated Cloudinary deletion failure retries without false completion | **PASS (mocked provider)** | `npm test`: file/folder deletion failure injection preserves durable inventory, enters retrying/failed state, and completes only after retry. No claim of a real provider outage. |
| 10 | Simulated DB failure after cloud deletion reconciles metadata | **PASS (mocked provider/DB failure)** | `npm test`: folder/file deletion and upload lifecycle tests simulate post-remote commit failure, expired lease and process interruption; retries finish metadata without falsely reporting completion. No real Atlas outage was induced. |
| 11 | Logout/lock denies API and media | **PASS (synthetic browser/HTTP; live provider denial)** | `lock:check`, `folders:ui-check`, `test:e2e`, and `media:access-check` verify locked/anonymous requests fail, including media and unsigned provider delivery. |
| 12 | Another authenticated device recovers vault key and reads stored content | **BLOCKED** | `settings:check` and key unit tests pass two-context recovery/session flows. The recovered second browser did not fetch and decrypt an actual stored Cloudinary file. |
| 13 | Refresh/reopen PWA and interrupted upload recover/retry honestly | **BLOCKED** | `pwa:check`, `offline:check`, and `npm test` cover shell reopening and mocked job recovery. Physical app suspend/reopen plus a real interrupted browser transfer were not run. |

No public sharing or signup is a release requirement outside the numbered journeys. `test:e2e` confirms `/signup`, `/register`, `/share` do not exist and private API prefixes deny anonymous requests. This does not exhaustively prove absence of every possible public delivery URL; the live synthetic unsigned Cloudinary test covers the tested object mode.

## Manual acceptance worksheet (not executed)

Use only disposable files whose loss is acceptable. In VS Code, open **Terminal → New Terminal**, run `npm run dev`, and open the printed localhost address. Sign in with your existing owner password, then unlock the separate vault key in **Settings**. Do not paste passwords, recovery keys, `.env.local`, or private filenames into an issue or chat. Record a date, device/browser, observed result and redacted error code for each item.

1. On a **separate test deployment/database**, confirm owner bootstrap runs once and a second run refuses; then sign in, lock, and unlock. Do not reset the existing owner to perform this test.
2. Open the HTTPS deployment on a physical Android phone in Chrome, choose **Install app**, open its standalone icon, background/resume it, and verify it returns locked under the configured policy. Also follow the app's iOS Safari **Add to Home Screen** instructions on a real iPhone if iOS support is claimed.
3. Generate or select a disposable roughly 10 MB JPEG. Upload from **Uploads**. Verify the app labels the optimized-only result, the final **stored ciphertext** size is strictly below 1,000,000 bytes, then preview and download it. Open the downloaded image and check orientation and appearance. Compare the ready record with the provider-reported byte count without copying any secret URL.
4. Use a disposable, compressible video with audio. Verify local output actually plays with sound; upload, seek near the end, download and play it, and confirm provider bytes are strictly below 100,000,000. On this plan, mark the near-100 MB case **BLOCKED** until a larger verified raw-object cap or reviewed segmented design exists. A whole-file Blob playback does not pass streaming.
5. Try a high-detail image/video that cannot meet the quality floor and size cap. Verify an actionable failure, no `ready` file, and a retryable/cleanup job where appropriate.
6. Create nested folders; upload disposable image, video and document files into them; search names only while unlocked; rename and move a file/folder; refresh and check IDs and counts remain consistent.
7. Delete one disposable image with a thumbnail. Confirm the UI stays pending until its full inventory and MongoDB record are gone; check the provider Admin view for both objects. Do not infer immediate CDN purge from an Admin lookup alone.
8. Create two sibling folders containing disposable files. Delete one nested subtree. Confirm its cloud objects and database rows disappear while the sibling remains intact.
9. In a disposable test environment, inject a mock provider failure; confirm the job says retrying/failed and never completed, then use **Deletions → Retry** and verify completion.
10. In a disposable test environment, inject a post-cloud DB failure; restart the recovery worker and confirm metadata removal is finalized without deleting unrelated objects.
11. Lock or log out, then revisit an earlier file page and an old media/download URL. They must deny access and must not reveal private bytes or names.
12. On a second browser/device, sign in and recover/unlock the vault key using the independently stored recovery material. Confirm a previously stored disposable file can be decrypted and downloaded there.
13. Refresh during a pending upload, briefly disconnect the network, then reopen the installed app. Verify each job is ready only after provider verification or is clearly retryable/failed; check no duplicate ready file appears.

## Release decision

**BLOCKED for full PRD §16 acceptance.** The unit suite and tested security boundaries pass, but the table's blocked journeys remain release gates. In particular, the video provider cap and encrypted seek format need architectural resolution; physical phone/PWA and complete media browser journeys need direct evidence. Keep the PRD §16.2 definition-of-done items unchecked until their complete acceptance evidence exists.

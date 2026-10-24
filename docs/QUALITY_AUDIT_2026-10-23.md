# VaultX gallery quality, performance, and security audit — 2026-10-23

**Release decision: BLOCKED.** This report records what was run today. `PASS` is scoped to the named test; it does not imply production acceptance. The configured Atlas database currently has zero media records. The Cloudinary account inventory has 60 image/upload and 4 video/upload assets with no matching references in that database. No existing asset was imported or removed.

## Commands and results

| Command | Result | Scope |
| --- | --- | --- |
| `npm run lint` | PASS | ESLint |
| `npm run typecheck` | PASS | Next type generation and TypeScript |
| `npm test` | PASS, 154/154 | Unit and contract tests, mostly synthetic stores/providers |
| `npm run build` | PASS | Node production build; not a deployed-host acceptance test |
| `npm run test:e2e` | PASS, 6/6 | Local Chrome, anonymous access and photo viewer desktop/mobile emulation |
| `npm run auth:check` | PASS | Isolated Atlas owner login, expiry, rotation, lock, rate limit, logout |
| `npm run lock:check` | PASS | Synthetic HTTP auth, CSRF, IDOR, private media denial, headers |
| `npm run pwa:check` | PASS | Local production Chrome, installability, offline shell and public-only cache |
| `npm run security:bundle-check` | PASS | 46 public bundle files checked against 6 configured secret values |
| `npm run media:access-check` | PASS | Disposable Cloudinary object, anonymous denial and exact gateway ranges; object removed |
| `npm run uploads:integration-check` | PASS | Small synthetic encrypted image/video/other objects, Cloudinary verification and isolated Atlas commit; disposable database removed |
| `npm run deletions:live-check` | PASS | Disposable single object removed from Cloudinary and isolated Atlas; repeated delete idempotent |
| `npm run deletions:folder-check` | PASS | Isolated Atlas deep tree with mock Cloudinary provider, retry and sibling preservation |
| `npm run image:check` | PASS | Local browser synthetic ~9.3 MB JPEG optimized to 929,558 bytes; **estimated** encrypted size 929,817 bytes |
| `npm run video:check` | PASS | Small synthetic local H.264/AAC transcode, duration/play/seek; **estimated** encrypted size 84,339 bytes |
| `npm run folders:ui-check` | PASS after harness repair | Isolated local MongoDB, desktop/phone Chrome, login, folder/file operations, lock |
| `npm run offline:check` | PASS | Synthetic encrypted local copy, unlock, download, lock and deletion event |
| `npm run gallery:db-check` | PASS | Read-only owner-scoped Atlas gallery queries |
| `npm run migration:media:dry-run` | PASS as audit | 0 Atlas media rows; Cloudinary inventory 64 unreferenced upload assets; 0 migrated |
| `npm run gallery:index-audit` | **FAIL** | Only 13/17 expected indexes exist; 4 `files` indexes are missing |
| `npm audit --omit=dev --json` | PASS, 0 advisories | Production dependency graph |
| `npm audit --json` | **FAIL**, 5 high entries | One root advisory in the development-only ESLint chain; no published `braces` patch |

## Requested journey matrix

| # | Journey | Result and evidence |
| --- | --- | --- |
| 1–4 | Login, logout, wrong password, protected pages and APIs | PASS in synthetic Atlas/HTTP and anonymous Chrome tests; production HTTPS remains untested. |
| 5–6 | Image/video upload | PASS for small synthetic encrypted provider objects; complete browser selection → optimization → upload → preview on production is BLOCKED. |
| 7–8 | Multiple/interrupted uploads | PASS in unit state-machine tests; live interrupted browser transfer and refresh recovery are BLOCKED. |
| 9–10 | Signature restrictions and metadata verification | PASS for server-owned upload intent, no browser-visible Cloudinary signature, provider identity/byte/header checks in contract and small live probes. Production account restriction/alternate URL matrix is BLOCKED. |
| 11–12 | Pagination, filter and search | PASS in bounded unit tests and read-only Atlas query check. Large real-gallery latency and memory benchmarks are BLOCKED because configured media count is zero. |
| 13 | Photo viewer | PASS in desktop and touch-emulated Chrome interactions; live stored photo preview is BLOCKED. |
| 14 | Video player | **BLOCKED**. Existing encrypted MP4 is download-only; no segmented MediaSource playback or large-video seek. |
| 15 | Downloads | PASS for synthetic authenticated range/decrypt tests; live end-to-end stored media download remains BLOCKED. |
| 16 | Albums and tags | PASS for schema, authorization, encrypted metadata and query contracts; authenticated browser album CRUD and live media are BLOCKED. |
| 17–19 | Single, bulk and partial deletion failures | PASS for disposable live single deletion, and bulk/failure contracts. Live bulk and recursive Cloudinary deletion with injected partial failure are BLOCKED. |
| 20 | Existing data migration | Dry-run PASS: zero source media rows in configured Atlas, 64 unreferenced Cloudinary upload assets. No migration was possible or claimed. |
| 21 | Mobile responsiveness | PASS for Chrome emulation and synthetic folder UI; physical Android and iOS checks are BLOCKED. |
| 22 | PWA | PASS for local Chrome installability and public-only cache. Production HTTPS and physical-device install/resume are BLOCKED. |

## Security and performance findings

1. **Fixed:** Album counts previously accepted any `ready` image/video row. They now require the same authenticated raw ciphertext identity, manifest kind, and byte binding used by gallery totals. A test covers legacy-row exclusion.
2. **Fixed test harness:** The synthetic folder browser check omitted the now-required email and Auth.js gate. It now uses disposable child-process auth configuration and passes. No local credential file changed.
3. **Database action pending approval:** The live `files` collection lacks `owner_folder_ready_category`, `cloudinary_public_id_unique`, `owner_ready_favorite_date`, and `owner_category_ready_date`. This weakens query performance and removes a database-level duplicate-ID guard. The collection has zero records, but no indexes were created because the owner requires approval before database configuration changes. After approval, `npm run db:indexes` creates all declared model indexes, and `npm run gallery:index-audit` verifies them.
4. **Dependency advisory:** The full audit's five high entries share `braces@3.0.3` through `micromatch → fast-glob → @next/eslint-plugin-next → eslint-config-next`. The production-only audit reports zero findings. The [GitHub advisory](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) lists no patched version. npm proposes an incompatible ESLint config downgrade, so this development-tool risk remains open.
5. **Private delivery:** The disposable Cloudinary probe denied anonymous retrieval and served exact authorized ranges. This does not prove every URL variant or the 64 pre-existing `upload` assets are private. Those assets are outside VaultX metadata and were not modified.
6. **Large-gallery performance:** Gallery uses server keyset pagination and a 36-card page, then decrypts names/tags in the unlocked browser. The icon grid fetches no original media or thumbnails; the selected one-object layout has no private thumbnail variants to lazy-load. Index gaps are actionable; real thousands-item latency, memory, API frequency, and Atlas M0 quota consumption were not measured with zero records.
7. **Secret and cache boundaries:** `.env.local` is Git-ignored; the public bundle scan passed. Service worker tests show only public offline shell files cached, while selected encrypted copies use a separate IndexedDB design. A current scan cannot prove Git history, device snapshots, downloads, or browser-owned caches are clear.

See [release gates](RELEASE_GATES.md) for the remaining production evidence and [migration report](../reports/media-migration-dry-run.json) for the redacted inventory. Do not store irreplaceable private files while the release decision is blocked.

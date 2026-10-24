# VaultX website recheck: 2026-10-23

**Release decision: BLOCKED for genuine private or irreplaceable files.** This is a local and disposable-fixture recheck, not proof of every [release gate](RELEASE_GATES.md) on a deployed host. After the owner authorized fixing the reported Atlas index failure, four indexes were added to the existing `files` collection. Credentials, existing records and assets, and production settings were not changed.

## Executed checks

| Area | Command / boundary | Result |
| --- | --- | --- |
| Lint, TypeScript, 157 unit/contract tests, production build, public-bundle secret scan | `npm run verify:production` | PASS; 157/157 tests after the fMP4 structure checks; build and 46-file bundle scan passed |
| Public pages, login password visibility, anonymous route denial, responsive photo-viewer controls | `npm run test:e2e` | Historical PASS; 6/6 local Chrome tests at the time. The standalone photo-viewer test and component were later removed when the gallery UI was simplified; use current test output for the present suite. |
| Desktop/phone folder and file journeys, owner-only APIs, lock, album create/edit/delete | `npm run folders:ui-check` | PASS with synthetic records and local browser emulation |
| Passkey, PIN and unsupported-browser fallback | `npm run passkey:browser-check`, `npm run device:check` | PASS with synthetic credentials and virtual authenticator; no physical biometric device tested |
| Login, rate limit, session rotation/expiry, lock, media denial, CSRF, forged IDs | `npm run auth:check`, `npm run lock:check`, `npm run settings:check`, `npm run security:browser-check` | PASS on local HTTP/browser and isolated Atlas fixtures |
| Browser image/video optimization | `npm run image:check`, `npm run video:check` | PASS with synthetic media. The video check now also validates a small FFmpeg fragmented-MP4 remux structure. It does not prove MSE playback or a large video stored and streamed from Cloudinary. |
| PWA/offline ciphertext | `npm run pwa:check`, `npm run offline:check` | PASS in local Chrome emulation; deployed HTTPS and physical devices untested |
| Upload verification and ciphertext ranges | `npm run uploads:integration-check`, `npm run media:access-check` | PASS with disposable small Cloudinary objects and isolated Atlas data; test objects cleaned up |
| Single-file and recursive deletion | `npm run deletions:live-check`, `npm run deletions:folder-check`, `npm run deletions:folder-provider-check` | PASS for disposable live single file and a nested folder with real Cloudinary main/thumbnail objects; deeper 71-folder test used Atlas plus a mock provider. Both test setups cleaned up. Production failure/retry behavior remains unproved. |
| Recovery of a stored private object | `npm run recovery:stored-check` | PASS: after clearing app-held key material, a fresh recovery-key unlock decrypted a disposable Cloudinary ciphertext object fetched in authenticated ranges. This was one local machine, not a second physical device. Test object removed. |
| Atlas connection, owner, gallery queries, configuration | `npm run db:check`, `npm run owner:status`, `npm run gallery:db-check`, `npm run config:check` | PASS; existing owner found; no credentials printed |
| Existing media migration inspection | `npm run migration:media:dry-run` | PASS read-only; zero candidate records; no migration performed |
| Git secrets and runtime dependencies | `npm run security:git-check`, `npm audit --omit=dev` | PASS; no configured secret found in eligible Git files/history; zero runtime dependency findings |
| All dependencies, including build tooling | `npm audit --json` | FAIL: five high findings in the development ESLint dependency chain; no compatible in-place fix reported by npm |
| Atlas gallery indexes | `npm run gallery:index-repair -- --check`, `npm run gallery:index-repair -- --apply`, `npm run gallery:index-audit`, then repeat `--check` | PASS: read-only duplicate preflight passed, four missing `files` indexes were created, audit reports 17/17 present, and repeat preflight reports zero missing. No records were deleted. |

## Fixes made during this recheck

- Repaired the passkey browser check: it now supplies a synthetic owner email and Auth.js test configuration and waits for the streamed login form before checking the unsupported-browser fallback. The actual app was not changed for this test-harness fault.
- Added a synthetic album create, edit and remove journey to the browser check. It passed and verifies the media remains after album removal.
- Repaired the Atlas index drift after an explicit read-only duplicate preflight; created only the four missing `files` indexes. Added an idempotent scoped repair command.
- Added two disposable live checks: nested Cloudinary plus Atlas deletion with sibling preservation, and recovery-key decryption of stored private ciphertext through authenticated ranges.

## Still blocked or unverified

- A continuous browser journey from optimized disposable image/video through private encrypted upload, preview and download on the deployed origin. Small live-provider probes and local encoder tests cover separate boundaries.
- Encrypted video playback and bounded-memory seek from stored ciphertext. Existing videos remain download-only. The owner approved a **new-video-only segmented design**, but the format, upload transaction, playback controller, and migration are not implemented; see [video blocker](VIDEO_STREAMING_BLOCKER.md).
- The intended near-100 MB encrypted video path on the account's **currently verified 10,485,760-byte raw-object cap**, production recursive deletion with failure recovery, recovery on a second physical device, and physical Android/iOS PWA behavior.
- Production hosting and every production evidence item in [release gates](RELEASE_GATES.md). The current [deployment guide](DEPLOYMENT.md) records a Vercel payload compatibility blocker.

Use disposable media only until the release gates pass. Do not put passwords, recovery material, private files, or `.env.local` in test reports.

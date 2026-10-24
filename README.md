# VaultX

VaultX is being built from the [product requirements](./prd.md) as a private, single-owner file vault. Password sign-in, protected pages, vault-key setup, bounded encrypted uploads, authenticated ciphertext retrieval, browser-side downloads, and a basic private photo/video grid are implemented. The gallery decrypts eligible stored photos for viewing; encrypted videos cannot yet play and seek in the app. **Use disposable files only. Do not store genuine secrets or irreplaceable private files here until every [release gate](./docs/RELEASE_GATES.md) passes.** Read the [final PRD audit](./docs/PRD_AUDIT.md) and [security review](./docs/SECURITY_REVIEW.md) before using sensitive files or deploying it.

## Daily owner guide (begin here)

This guide describes the current app and its limits. Use disposable copies while release acceptance is blocked. Keep the originals and a separate backup outside VaultX.

1. **Open VaultX:** Start the app using the Windows steps below. Open the Local address shown in the VS Code terminal, usually `http://localhost:3000`. On an installed PWA, tap its icon. If the app was closed, refreshed, or locked, you should see `/unlock`.
2. **Sign in and unlock files:** Enter your **owner login password** on `/unlock`. The app opens **My gallery**. On first use, create a separate vault passphrase, save the one-time recovery key offline, and re-enter it to confirm. Upload stays disabled until that encrypted backup is saved in MongoDB. On later visits, enter the vault passphrase (or your saved recovery key). Login opens the owner session; the second step gives this browser the key needed to decrypt names and files. PIN/passkey login does not replace the second step. Click **Lock** before leaving an unlocked device; **Sign out** ends the session.
3. **Add a test photo or video:** On **My gallery**, click **Upload photos or videos** and select files from your phone gallery or computer. Each file is optimized, encrypted on your device, and uploaded with a separate encrypted small preview. Wait for **ready** after Cloudinary verification. Failed or cancelled items are not stored files. The current account allows under 10,000,000 ciphertext bytes per object, including encryption overhead, and images must also be under 1,000,000 bytes. Longer videos may be rejected; keep your originals elsewhere.
4. **View, download, or delete:** The gallery loads a page at a time. New files show small private thumbnails, decrypted only while unlocked. Older files without a stored thumbnail show an icon and remain available. Click a photo to open it; use **Download** to save the retained optimized photo or video. Videos currently download but do not play inside the app. Click **Delete**, then confirm. A completed result means both active Cloudinary objects and the MongoDB record were removed; a pending result can be checked under **Deletions**. The older Files, Albums, Uploads and other routes remain in the code for existing data, but are hidden from the simple main navigation.
5. **Keep a real backup:** Keep your original files and an independent backup you control. VaultX has no complete vault export/restore tool. Losing both your vault passphrase and your one-time recovery key can make stored ciphertext unreadable. Keep the owner login password, vault passphrase and recovery key in a trusted offline password manager or other secure offline location; keep a copy that survives loss of this phone. Never paste them into chat, screenshots or `.env.local`.
6. **Change passwords:** Open **Settings**. **Change login password** requires the current login password and signs out all devices; sign in again afterward. **Change vault passphrase** requires the old vault passphrase and current login password, rewraps the master key and signs out devices. It does not reupload or re-encrypt every file. If a vault key or recovery key is compromised, passphrase rotation alone is insufficient; stop using the vault until a reviewed re-encryption/recovery replacement flow exists.
7. **Use another browser or phone:** For a first rehearsal, open `http://localhost:3000` in a second browser on the same computer. On a different phone, use only your trusted deployed HTTPS address; that deployment is not verified yet. Sign in with the owner login password, then open **Settings > Vault encryption keys**. Enter the vault passphrase or the recovery key saved during setup. Confirm a disposable stored file can be downloaded and opened there before trusting this recovery path. The app has not yet passed that full cross-device content test. A recovery key cannot be redisplayed from Settings.
8. **Watch deletion and retry jobs:** A file or folder deletion first hides it and creates a durable job. Open `http://localhost:3000/vault/deletions` to see pending, retrying and failed jobs; use **Retry now** on a failed job. The page can trigger due recovery while open. A trusted external scheduled runner is needed when the page is closed; follow the [recovery setup](./docs/RECOVERY.md). Do not assume a pending job has finished.
9. **Understand storage errors:** If optimization fails, use a smaller/shorter disposable file or keep the original outside VaultX. The strict image limit is **below 1,000,000 stored encrypted bytes**; the current account's last measured raw-object cap is **10,485,760 bytes**, with a more conservative app transfer cap below 10,000,000 bytes. Cloudinary storage, bandwidth, backup settings and quotas can change; check your own Cloudinary Console and the [provider report](./docs/CLOUDINARY_FEASIBILITY.md). VaultX cannot promise free unlimited storage or service availability. Keep a separate copy before retrying or deleting anything.

**What “Completed in active storage” means:** VaultX has confirmed the tracked Cloudinary active object(s) absent and removed the associated MongoDB record(s), then clears VaultX-managed local copies where possible. It does **not** prove instant erasure of a previously signed CDN response, provider backups/retention, browser downloads, screenshots or copies on another disconnected device. Cloudinary CDN invalidation can lag. Review provider backup/retention settings yourself; see [the deletion audit](./docs/PRD_AUDIT.md#p0-proof-gates).

## Run it on Windows

1. Install Node.js LTS from the official **Node.js** website and Git from the official **Git** website if they are missing. npm is included with Node.js.
2. In VS Code, choose **File > Open Folder...** and select `D:\VaultX`.
3. Choose **Terminal > New Terminal**. The terminal should show `D:\VaultX` as its working folder.
4. Run `npm install` if dependencies are not already installed.
5. Run `npm run dev`.
6. Open `http://localhost:3000` in your browser. Keep the terminal open while using the development server. Press **Ctrl+C** in the terminal to stop it.

The home page opens `/unlock` when signed out and `/vault` when signed in. Every `/vault/*` page requires a current owner session on the server. The `/design-system` component preview is available in development only; it contains no private data.

VaultX can be installed as a PWA from a supported browser on an HTTPS deployment. Open `/install` for phone and desktop steps, including iPhone Safari's **Add to Home Screen** flow. The public offline screen contains no private files. See [PWA setup, security, and verification](docs/PWA.md). After `npm run build`, `npm run pwa:check` checks the production PWA in local Chrome.

If port 3000 is in use, Next.js may print another localhost address. Open the address shown after **Local:** in the terminal.

## Useful commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the local development server |
| `npm run lint` | Check code with ESLint |
| `npm run typecheck` | Check TypeScript types |
| `npm run config:check` | Validate MongoDB, Cloudinary and Auth.js variable names/formats without displaying values or contacting providers |
| `npm run build` | Create a production build |
| `npm run start` | Run an existing production build |
| `npm test` | Run automated tests |
| `npm run db:check` | Ping your configured MongoDB Atlas database without printing the URI |
| `npm run gallery:db-check` | Check the private gallery's shared Mongoose connection and read-only Atlas queries without displaying media |
| `npm run db:indexes` | Create or confirm the model collections' indexes in your configured Atlas database |
| `npm run owner:status` | Report whether zero or exactly one owner record exists, without showing credentials |
| `npm run owner:bootstrap` | Create the single owner from a hidden password prompt |
| `npm run auth:check` | Exercise synthetic sign-in, expiry, rate limits, rotation, and logout in a temporary Atlas database |
| `npm run lock:check` | Run the built app with a temporary Atlas database and verify authorization, CSRF, forged IDs, lock, and expiry |

## Project layout

- `src/app/` contains App Router pages, layouts, route handlers, CSS, and safe loading/error/not-found screens.
- `src/components/` contains reusable UI and feature components.
- `src/hooks/` contains browser-only state hooks; the vault-key status hook holds no key material.
- `src/lib/` contains domain rules, crypto, auth, environment validation, and the existing MongoDB/Cloudinary implementations.
- `src/models/` is the stable entry point for existing typed MongoDB schemas/collections; definitions and indexes remain in `src/lib/database/models.ts`.
- `src/services/` exposes server-only database and Cloudinary integrations without changing their configured accounts or object layout.
- `src/types/` contains shared data-only TypeScript types. Existing `src/lib/files/types.ts` imports continue to work.
- `@/*` imports resolve to `src/*`. `.env.example` documents variable names without credentials; `.env.local` stays ignored by Git.

Keep your existing `.env.local`. Run `npm run config:check` to check variable presence and format without showing values; it does not test a live connection. `npm run db:check` tests Atlas connectivity. VaultX now requires both its revocable MongoDB owner session and an Auth.js sign-in cookie bound to that session. In `.env.local`, add `AUTH_OWNER_EMAIL=your-own-email@example.com` and keep the existing `AUTH_SECRET` (at least 32 bytes). Do not paste either value into chat. For an HTTPS deployment, set `NEXTAUTH_URL` to the exact site origin. Restart `npm run dev` after changing environment variables. Vercel deployment remains blocked by the existing payload-limit prebuild check described in [the deployment guide](./docs/DEPLOYMENT.md). A normal Node.js production build can run, but production use still requires the separate [release gates](./docs/RELEASE_GATES.md).

To sign in, open `http://localhost:3000/unlock`, enter the same owner email you configured and your existing owner password. The password stays protected by the existing Argon2id hash in MongoDB; Auth.js adds a separate HttpOnly cookie. If you have not initialized an owner, run `npm run owner:status`, then `npm run owner:bootstrap` only when it reports no owner. The bootstrap asks for a strong password in a masked terminal prompt and never accepts it in a command argument. Do not create another owner or share the password. PIN and passkey unlock still require the owner email and still require the separate vault passphrase or recovery key to decrypt files.

To connect your own database, follow the [click-by-click MongoDB Atlas setup guide](./docs/mongodb-atlas-setup.md). Put the URI only in the root `.env.local` on your computer; `.env.local` is ignored by Git. Never put MongoDB, Cloudinary, or auth secrets in variables beginning with `NEXT_PUBLIC_`.

The Uploads page can prepare files locally, encrypt them, and send bounded ciphertext through an owner-authorized server route to Cloudinary `raw/authenticated` storage. The account's verified 10 MiB raw cap is enforced conservatively at **under 10,000,000 ciphertext bytes**. The signed browser-direct upload design remains blocked. See the [Cloudinary feasibility guide](./docs/CLOUDINARY_FEASIBILITY.md).

Upload completion checks Cloudinary identity, restricted mode, stored byte count and ciphertext header before the file becomes ready. The browser stores pending job IDs and encrypted completion metadata in tab session storage so it can check or finish a transferred job after refresh. A lost file selection cannot be resumed after refresh; select the source again after cancelling the old job. Run `npm run recovery:run -- --run` on a trusted server to clean expired unfinished jobs. It may delete Cloudinary objects; it does not change ready files. See [recovery setup](docs/RECOVERY.md).

For disposable provider verification, `npm run uploads:live-check` creates and removes three small synthetic ciphertext objects. `npm run uploads:integration-check` also uses a separately named temporary Atlas database and removes it afterward. Neither command uses personal media. Keep your originals if you may need them: optimized uploads do not retain the original bytes.

## Create the single owner (one time)

1. Before setup, rotate any Atlas or Cloudinary credentials that were shared in chat, and update only your local `.env.local`. Never paste your owner password into `.env.local`, a command, chat, or a screenshot.
2. In VS Code, choose **Terminal > New Terminal**. Check that the prompt is in `D:\VaultX`.
3. Run `npm run db:check`. Continue only when it says Atlas responded to ping.
4. Run `npm run owner:status`. It should say no owner is initialized. If it reports one, setup is already complete.
5. Run `npm run owner:bootstrap`. Type a private, randomly chosen passphrase of at least 16 characters and press Enter; the terminal deliberately shows no password characters. Type it again to confirm. The account's username is `owner`.
6. Run `npm run owner:status` again. It should report exactly one owner. Rerunning the bootstrap command refuses to create another account before asking for a password.

The command saves only a salted Argon2id password hash in MongoDB. Keep the password safe. Creating an owner does not sign you in or create a vault encryption key.

## Sign in and sign out

After owner bootstrap, run `npm run db:indexes` once to add the database indexes, then run `npm run dev`. Open the **Local** address printed by Next.js, usually `http://localhost:3000/unlock`. Type your owner password in the form and click **Unlock VaultX**. A valid password opens the protected route shells; **Sign out** in the top bar ends the session. The username is fixed to `owner`, so there is no username field or public signup.

Eight login attempts are allowed per 15-minute window across this single-owner deployment. If the limit is reached, wait for the next window; do not share your password to troubleshoot it. A session expires after 15 minutes of inactivity by default and always after eight hours. The visible app sends authenticated heartbeat requests while you are active. The browser cookie is HttpOnly and SameSite Strict, with Secure enabled in production. Production must use HTTPS. Signing out removes the MongoDB session and clears the cookie.

Click **Lock** in the top bar to require the password again. Opening or refreshing a vault URL also returns to `/unlock`. Switching apps, hiding the browser tab, or returning to a restored page triggers a lock when the browser delivers those events. In **Settings**, choose 1, 5, 15, 30, or 60 minutes for the idle timeout; enter your current login password to save, then unlock again. After locking, the session stays marked locked in MongoDB, so direct requests for vault pages, ciphertext, and downloads are denied.

VaultX clears registered mutable key buffers on lock or sign-out. Browser events and JavaScript memory erasure are best effort: an operating system kill, frozen browser, lost network, or copies held outside VaultX code can prevent immediate cleanup. The server's idle and absolute expiry still bound access; use **Lock** before handing someone an open device.

## Set up your vault encryption key

1. Sign in with your **owner login password**, then open **Settings**.
2. Under **Vault encryption keys**, create a **different** long vault passphrase. This passphrase stays in your browser; it is not sent to the login server. Keep both passwords safe.
3. VaultX will display a new recovery key once. Write it on paper or save it in a trusted offline password manager. Do not put it in chat, screenshots, `.env.local`, or a cloud note. Re-enter the full key and check the offline-storage box to save the encrypted backup.
4. To test another browser, open a private window or another device, sign in with the owner login password, open **Settings**, choose **Recovery key**, and enter the saved key. The second browser downloads only the encrypted key envelope and unwraps it locally. You can also use your separate vault passphrase there.

Setup refuses to overwrite existing keys and blocks old file, folder, or job records that lack migration metadata. A forgotten vault passphrase can be recovered with the saved recovery key; losing both can permanently prevent access to encrypted files. The recovery key cannot be displayed again after setup. The current 64 MiB, three-pass browser Argon2id setting and key flow still need independent review and testing on actual Android/iOS devices.

## Manage security in Settings

Open `http://localhost:3000/vault/settings` after signing in. **Signed-in devices** lists active browser sessions with an approximate browser label and timestamps; older sessions may say “Other browser.” Enter your current login password, then click **Revoke** beside a session. That browser's next private request is denied. Revoking this session returns you to the unlock screen. A remote browser can keep previously rendered content until its next heartbeat or lock event, so use its Lock button when you have access to it.

**Change login password** needs your current login password and a different strong replacement. Every session is invalidated, including the one you are using. Sign in again with the new password. This password does not wrap the vault key; the separate vault passphrase remains the same.

To change the **vault passphrase**, first unlock the vault key in Settings, then enter the old vault passphrase, a strong new one, and your current login password. VaultX rewraps the same master key locally, preserves the independent recovery-key backup, and signs out every device. Sign in again and unlock the vault key with the new passphrase. This does not re-encrypt or reupload Cloudinary files. If a master key or recovery key is compromised, changing a passphrase alone is insufficient; a reviewed full re-encryption and recovery-key replacement flow is still needed. Settings records when you confirmed offline recovery-key storage, but cannot verify that the copy remains available. Never paste your passwords or recovery key into the terminal, chat, or `.env.local`.

The storage card counts only ready encrypted objects recorded in MongoDB, including encrypted thumbnails. It explains the last verified Cloudinary raw-object size limit; check your Cloudinary Console for current quota and billing. `npm run settings:check` tests security changes against a disposable Atlas database with synthetic passwords and deletes that database afterward.

## Selected encrypted offline files

Selected encrypted offline files are also optional. While online, sign in, unlock the separate vault key in **Settings**, open a ready file, and click **Keep encrypted copy offline**. Open `/offline-vault.html` when disconnected and enter your **vault passphrase** to download a selected copy; owner login, PIN, and passkey alone cannot decrypt it. Use **Remove offline copy** on the file or **Clear offline copies** in Settings. Browser quotas, eviction, cleared site data, and app updates can remove access; deletion on another device is learned only after this browser reconnects. The offline viewer does not stream or preview media. See [offline design and limitations](docs/OFFLINE.md). After `npm run build`, run `npm run offline:check` for a synthetic production Chrome check.

## Optional PIN and platform passkey

After signing in with your login password, open **Settings > Optional device sign-in**. Enter your current login password before enabling a six-digit PIN or adding a passkey. The PIN belongs to this browser profile through a 30-day HttpOnly device cookie; VaultX stores only its SHA-256 digest and an independently salted Argon2id verifier of the PIN plus device token. Five wrong attempts block PIN sign-in for 30 minutes. Use **Reset PIN** or **Disable PIN** in Settings with your login password. A copied browser cookie can clone the convenience credential; this is browser-profile binding, not a hardware guarantee. Protect the device and use passkeys where possible.

**Add platform passkey** appears on supported secure browsers. Your device performs fingerprint, face, or device-PIN verification; VaultX stores only a public credential and counter. Password sign-in always works if your device does not support WebAuthn. In local development, `http://localhost:3000` works without extra configuration. For an HTTPS deployment, put the exact trusted site origin (for example, `https://vault.example.com`) in the server-only `WEBAUTHN_ORIGIN` variable, and its hostname in `WEBAUTHN_RP_ID`. Do not add a trailing slash. The deployment must actually serve that HTTPS origin. These are public site identifiers, not secrets. A change of hostname will require registering new passkeys at the new origin.

PIN and passkey sign-in create an owner session only. After locking, the app clears its held vault key where practical, so open **Settings > Vault encryption keys** and enter your separate vault passphrase or recovery key before viewing encrypted files. Neither the PIN nor WebAuthn restores that key. Changing your login password signs out all sessions and removes enrolled PINs and passkeys; enroll them again afterward. `npm run device:check` tests PIN limits and forged WebAuthn assertions in a disposable Atlas database. After `npm run build`, `npm run passkey:browser-check` uses Chrome's virtual authenticator and a disposable database to test a full passkey and PIN journey. Real fingerprint and Face ID prompts still need manual testing on your own device.

## Try folders in your browser

1. Run `npm run db:indexes` in the VS Code terminal, then `npm run dev`. Open the Local address shown by Next.js, usually `http://localhost:3000/unlock`.
2. Sign in, open **Settings**, and unlock the separate vault key with your vault passphrase or recovery key. Return to **Files** in the navigation.
3. Click **New folder**, type its name in the dialog, and click **Create folder**. Click the folder name to open it and create a nested folder. Use the back arrow or **Files** breadcrumb to return to Root.
4. Open the three-dot menu beside a folder, click **Rename**, type a new name, and click **Save name**. Its link and future file references use the same ID.
5. Open that menu and click **Move**. Browse to a destination folder, or stay at **Root**, then click **Move here**. A folder cannot move into itself or one of its children.
6. Click **Lock** in the top bar. The folder names disappear and the folder API refuses requests until you sign in again. Unlock the separate vault key in **Settings** before browsing folders again.

Folders are limited to 128 levels and listings show 100 at a time with **Load more folders**. The server checks ownership, parent relationships, deletion state and cycles. It cannot prove that browser-supplied ciphertext contains a meaningful name, so an altered client may create a folder that fails to decrypt.

The **+** button opens the same New folder dialog while you are on a Files page. For an isolated automated browser check, run `npm run build` and then `npm run folders:ui-check`. This check needs Google Chrome and local MongoDB Server 9.0 installed on this Windows computer. It uses temporary synthetic credentials and a disposable local database, without changing your Atlas folders. It saves desktop and phone-size screenshots under the ignored `test-results` folder. Phone-size emulation does not replace testing on a physical phone.

## File metadata and search

After unlocking the vault key, the **Files** section lists ready files in the current folder, 100 at a time. **Load more files** requests the next page. Click a card to see stored format, ciphertext size, and available output dimensions or duration. The file details page has **Rename** and **Move** buttons. Rename changes the encrypted display name while keeping the stored file format. Move lets you browse nested destinations; the server refuses deleting folders. The saved download uses the display name and the stored optimized extension. The labeled `TEST ONLY` cards in `npm run folders:ui-check` exist only in its disposable local database and have no Cloudinary objects.

Type in **Search filenames** to search ready files across all folders. Use **Type** to filter images, videos, audio, documents, or other files; use **Sort** for name, date, type, or stored size. The browser fetches owner-authorized pages and decrypts names locally after vault-key unlock. Search text is never sent to MongoDB or an API. Search and non-default sorting scan all matching pages, so large vaults may take longer. Names disappear from the UI when the key locks. The server stores encrypted names; format, category, ciphertext size, and optional output dimensions/duration are ordinary metadata under the PRD privacy model.

The main **Gallery** shows ready photos and videos, newest first, with encrypted thumbnails for supported new uploads. Older files without thumbnails show category icons. The **Files** route remains available for folder browsing and client-side filename search. Folder breadcrumbs show direct ready-file counts for each level.

## Permanent file and folder deletion

1. Sign in, unlock the vault key in **Settings**, open **Files**, and select a ready file.
2. Click **Delete permanently** and read the confirmation. Click **Delete this file** only when you intend to remove it.
3. The file is hidden once MongoDB has committed a durable deletion job containing its main ciphertext object and any recorded encrypted thumbnail. Open **Deletions** to see the job status. **Completed in active storage** appears only after Cloudinary confirms every recorded object absent and MongoDB removes the file record.
4. A failed job stays visible. Click **Retry now** for a manual retry. Due pending jobs also retry with backoff while the Deletions page is open. To process jobs while that page is closed, run `npm run recovery:run -- --run` regularly on a trusted server or configure a trusted Windows Task Scheduler task. See [recovery setup](docs/RECOVERY.md). Run `npm run db:indexes` once after upgrading to create the unique deletion-job index.

In **Gallery**, open a photo card to view it, or use **Download** or **Delete** on a card. Videos are download-only. Confirm deletion in the dialog; a pending job may still need recovery before the file is gone from both active stores. Open **Deletions** to see verified completion or retry failures. The gallery hides queued files, but disappearance from the grid is not proof of completed deletion. File rename, move, and folder operations remain available in the **Files** route.

For a provider integration check that does not touch personal files, run `npm run deletions:live-check`. It creates one synthetic encrypted object and an isolated Atlas database, verifies deletion and repeat requests, then cleans up. A failed check may retain the isolated database if remote cleanup cannot be confirmed; follow the command's redacted message.

To delete a whole folder tree, open its three-dot menu in **Files** and click **Delete permanently**. The dialog counts its nested folders, ready files, and encrypted objects. Review the counts, then click **Delete this folder**. The server checks the counts again, records the full inventory, and fences the subtree in one Atlas transaction. If the tree changed, or an upload or file deletion inside it is still active, no folder deletion starts; finish that job and try again. The Deletions page shows pending progress and retry controls. Its reconciler processes both file and folder jobs in bounded batches. For an isolated Atlas test using only synthetic records and a simulated provider, run `npm run deletions:folder-check`.

The current single-document job design safely rejects trees above 10,000 folders, 10,000 files, or 20,000 Cloudinary objects before fencing them. Those unusually large trees need a sharded inventory design. Cloudinary deletion requests include `invalidate: true`, but CDN invalidation may take time and is not a guarantee that provider backups, downloaded copies, screenshots, or third-party caches disappear. The status refers to active VaultX-managed Cloudinary assets and MongoDB records.

## Uploading files

Open **Uploads** after signing in and unlocking the separate vault key in **Settings**. Select multiple files on a phone or desktop, or drag files onto the desktop drop area. Images and supported videos are optimized locally. Review each local preview, then click **Encrypt and upload this result**. Other files are encrypted without lossy optimization. VaultX stores the optimized output only for images/videos, never the original. The image optimizer applies orientation, strips private metadata, preserves transparency and rejects animations it cannot preserve.

Images must remain strictly below 1,000,000 encrypted bytes. The server also verifies the actual Cloudinary ciphertext object size before marking a file ready. Run `npm run image:check` for isolated synthetic Chrome checks. Downloads return the stored optimized bytes and extension; keep source files if you need the originals.

## Local video limits

Supported MP4, MOV and WebM inputs are locally inspected and transcoded to H.264/AAC MP4 where the browser permits. The current account's raw cap restricts **this upload path** to under 10,000,000 encrypted bytes, so long videos will fail the quality floor. Review picture and sound in the local preview before approving. The PRD's near-100 MB single-object video goal is blocked by this Cloudinary plan.

This work can take a long time. **Cancel** terminates the worker. The browser refuses inputs over 600 MB, and videos over 256 MB on devices with unknown or less than 8 GB reported memory; over 128 MB is also refused below 4 GB. A 500 MB input is therefore possible only on a sufficiently capable device, and has not been proven to finish. If the duration leaves too little bitrate for a watchable resolution, the optimizer refuses the video. Run `npm run video:check` for a synthetic Chrome test that actually transcodes video with audio and verifies playback and seeking. See [video feasibility](docs/VIDEO_FEASIBILITY.md) for limitations and device status.

## Private API safety

All current `/vault` pages check the owner on the server. Private API prefixes require an unlocked owner session. Upload routes include `POST /api/uploads/init`, bounded `PUT /api/uploads/[id]/ciphertext`, `POST /api/uploads/complete`, and `GET`/`DELETE /api/uploads/[id]`. Each route authorizes again; mutations require same origin. The binary transfer route validates the exact body length and reserved ciphertext header. File access and download routes authorize by file ID and proxy authenticated ciphertext ranges for browser-side decryption.

Future private APIs must be explicitly enabled in the server gate and use the same route-level authorization and owner-scoped lookup helpers. Private API errors use a small `{ "error": { "code": "...", "message": "..." } }` response with `Cache-Control: no-store`. Run `npm run build` before `npm run lock:check`; that check runs the production build against a temporary synthetic Atlas database and deletes it afterward.

## Acceptance testing

Read [the PRD §16 acceptance matrix](docs/ACCEPTANCE_MATRIX.md) for exact commands, observed PASS/BLOCKED results, test boundaries, and a manual device worksheet. After `npm run build`, run `npm run test:e2e` for the Playwright production-browser checks. These checks do not turn the remaining full media and physical-device journeys into completed acceptance items.

For hosting, read [the deployment guide](docs/DEPLOYMENT.md) and [backup and restore runbook](docs/BACKUP_AND_RESTORE.md). `npm run verify:production` runs the local production code gates; `npm run security:git-check` compares configured secrets with Git-eligible files and current history without printing values. The current Vercel build is deliberately blocked because its Function request limit is smaller than VaultX's encrypted file transfer; use a compatible Node host only after its network, HTTPS, worker and disposable-file acceptance checks are complete. No automatic backup or restore test has been configured.

## Status

Owner bootstrap, sign-in, lock, vault-key recovery, folders, ready-file metadata, local optimization, bounded private ciphertext upload, authenticated download, file/folder deletion, selected encrypted offline downloads, and a public-shell PWA are active. The server can verify provider-reported bytes and ciphertext framing, but cannot authenticate decrypted media quality or type without vault keys. Password login does not unlock the separate client key. Segmented video playback, production HTTPS installation, and physical mobile device acceptance checks remain unfinished; keep original files if you need their unoptimized bytes.

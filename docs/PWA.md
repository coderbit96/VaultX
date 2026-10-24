# Installing VaultX

VaultX has a standalone web app manifest, original 192 px and 512 px icons, a maskable icon, a 180 px Apple touch icon, and a public offline screen. The installed app starts at `/`; the server locks any existing session there and sends the owner to `/unlock`. Returning to a suspended vault page also uses the existing visibility, page-hide, session, and server authorization checks. Browser or operating-system suspension can delay client events, so use **Lock** before handing over a device.

## Install on a phone or computer

Use an **HTTPS** VaultX deployment. `localhost` is treated as a secure context for local testing on the same computer, but a phone cannot install from your computer's `localhost` address.

- **Android Chrome:** Open the HTTPS address. Use VaultX's **Install** button if it appears, or Chrome's menu → **Install app** / **Add to Home screen**. Confirm, then launch the new icon. Chrome's exact wording and WebAPK behavior vary by device and browser services.
- **Desktop Chrome or Edge:** Open the HTTPS address, then use VaultX's **Install** button if shown, the install icon in the address bar, or the browser menu → **Install app**. Confirm and open the new app window.
- **iPhone/iPad Safari:** Open the HTTPS address in Safari. Tap **Share** (possibly under the page menu) → **Add to Home Screen**. Turn on **Open as Web App** if offered, tap **Add**, then open the Home Screen icon. Safari does not provide VaultX's in-page install prompt. Labels vary by iOS version. See [Apple's current instructions](https://support.apple.com/guide/iphone/turn-a-website-into-an-app-iphea86e5236/ios).

The public `/install` page repeats these instructions in the app. Installation does not save files for offline access. After launch, enter the owner password, then unlock the separate vault key in Settings. Cloud files require MongoDB, Cloudinary, the host, and a connection.

## Offline and updates

The service worker caches **only** `/offline.html`, `/offline-vault.html`, its two public viewer scripts, and four public icon PNGs. Explicitly selected encrypted ciphertext lives in IndexedDB; see [offline limits](OFFLINE.md). Navigation to `/`, `/unlock`, `/install`, or `/vault/*` always requests the server; if the connection fails, it shows the content-free offline page. It never caches a successful private page, auth/API response, media, thumbnail, decrypted content, upload, or Next.js bundle. Other requests go directly to the network. The browser's online indicator is only a connection hint; a successful server request is the real availability check.

The browser and operating system may retain decoded pixels in memory, recent app snapshots, downloads, or their own caches outside VaultX's control. Locking hides the app and clears VaultX-held keys and object URLs where practical; it cannot erase a downloaded copy, screenshot, operating-system snapshot, or every browser memory buffer. On logout, VaultX clears its managed encrypted offline copies and revokes its sessions. Use the device screen lock and close the app when sharing a device.

Gallery cards currently use file-type icons. The selected one-object encrypted storage layout has no small private thumbnail objects, so the grid does not fetch full-resolution ciphertext just to simulate lazy thumbnails. It pages metadata in batches of 36 and lets the browser skip painting cards outside the viewport.

The app checks for a worker update on open, when the connection returns, and about once per hour. A waiting update offers **Update and lock**. Choosing it hides the vault, clears app-held key material where practical, requests a server lock, activates the new worker, and opens `/unlock`. An update activated from another tab also locks and reloads. Do not change the service worker cache allowlist without a security review. The build script hashes the offline viewer bundles into the shell-cache version so an update replaces old public assets.

## Verification and limits

After `npm run build`, run `npm run pwa:check` on a computer with Google Chrome installed. It starts a temporary local production server and persistent Chrome test profile, verifies the manifest and icons, worker control, offline fallback, cache contents, lock-screen start route, phone-size layout, and Chrome installability errors. The test deletes its temporary profile afterward and saves a phone-size screenshot in the ignored `test-results` folder. `npm test` also checks the worker's allowlist and icon dimensions. `npm run lock:check` verifies owner authorization, lock, and media denial with a synthetic temporary Atlas database. In Chrome DevTools, **Application → Manifest** shows the installability and maskable icon checks; **Application → Cache storage** should contain only the eight public resources.

Local production Chrome reported zero installability errors and produced an install event. This is a localhost secure-context check, **not an HTTPS deployment check**. No public HTTPS deployment URL was available in this step, and no physical Android or iOS device was connected. Verify installation and returning from the background on those devices after deploying to HTTPS. Browser install UI is conditional and can be absent if already installed, in private browsing, or under a browser policy. iOS installation uses the Share menu instead of the Chromium `beforeinstallprompt` event. Selected encrypted copies can be downloaded from the separate offline viewer with the vault passphrase; physical mobile-device acceptance remains pending.

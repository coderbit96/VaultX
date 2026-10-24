# Selected encrypted offline copies (optional P1)

## What works

While signed in online with the separate vault key unlocked, open a ready file's details page and choose **Keep encrypted copy offline**. VaultX downloads the authenticated ciphertext through the owner-only range gateway in 1 MiB blocks. It stores those ciphertext blocks in IndexedDB, then locally authenticates and hashes the entire file before marking the copy available. It saves a separate AES-256-GCM sealed metadata record containing the encrypted filename, file manifest, stored format and size. A copy is explicit and per browser profile. Files not selected remain cloud-only.

An encrypted copy of the existing vault-key envelope is also saved. The public offline viewer at `/offline-vault.html` asks for the **separate vault passphrase** and runs the same Argon2id key derivation locally in a worker. It never treats a PIN, passkey, or cached owner cookie as a way to recover the vault key. The viewer checks the metadata seal and versioned file authentication before delivering a decrypted download. It locks on backgrounding/page exit and after five minutes idle. Downloads are explicit plaintext exports saved by the browser; they are outside VaultX-managed caches. On browsers without a streaming save picker, local downloads above 32 MB are refused to avoid a large plaintext Blob.

The service worker caches only `/offline.html`, `/offline-vault.html`, the two public viewer scripts, and original public icons. It does not cache private routes, API responses, thumbnails, encrypted file responses, or any plaintext. The encrypted copy database is separate from Cache Storage. Offline viewing currently provides authenticated **download**, not streaming video playback or inline previews.

## Removal and limits

**Remove offline copy** on the file details page or in the viewer removes one file. **Clear offline copies** in Settings or the viewer clears ciphertext blocks, encrypted metadata, and the local key envelope. Sign-out and current-session revocation clear them. Starting a local file deletion removes that file's copy; starting a folder deletion clears all local copies because the browser cannot safely know the entire subtree from its local index. When the owner opens VaultX online, it rechecks selected file IDs and removes copies whose owner-scoped ready record has disappeared.

An offline browser cannot learn that a file was deleted, a session revoked, or the owner account removed on another device. Such a copy remains locally decryptable with the vault passphrase until this browser reconnects or the user clears browser storage. This is an intrinsic limit of offline access. If immediate cross-device revocation is required, disable the offline feature or use a device-managed storage solution. A previously downloaded plaintext file also remains under the user's control.

Rotating the vault passphrase clears copies on the device where rotation is performed before the server change. Another disconnected device can still hold its old encrypted envelope and use the old passphrase until that device reconnects and clears its copies. VaultX does not currently have an owner-removal UI; deletion of the owner directly in MongoDB cannot reliably erase data from offline devices.

VaultX limits selected ciphertext to 500 MB per browser profile and checks the browser's approximate storage quota before saving. The browser may enforce a lower quota, reject a write, or evict IndexedDB data under storage pressure. `navigator.storage.persist()` is requested when available but may be denied. Private/incognito storage usually disappears when the session ends. Clearing site data removes copies. App updates change the public shell cache; they do **not** guarantee that IndexedDB or compatible decryption code will remain available. Keep an independent encrypted backup of important files.

## Verification

Run `npm run test` for the isolated IndexedDB contract test, then `npm run build` and `npm run offline:check` for the production Chrome offline shell, Argon2id passphrase unlock, verified download, lock, and deletion-event check. This browser check uses synthetic ciphertext and does not read personal files or use the real owner database. Manual acceptance remains necessary on Android Chrome and iOS Safari, including storage eviction and download behavior. A deployed PWA needs HTTPS; localhost is a secure-context exception.

Browser storage quota and eviction behavior follow [MDN's storage quota guidance](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria). IndexedDB transaction completion and its durability limits are described in [MDN's IndexedDB guide](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API/Using_IndexedDB).

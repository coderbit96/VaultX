# Local decryption, safe previews, and downloads

VaultX fetches ciphertext only from `/api/files/:id/access`. Every request uses the current owner cookie and server-side ready/owner checks. The browser supplies an exact byte range; the server validates and forwards only that range from the server-selected `raw/authenticated` Cloudinary asset. Responses use `Cache-Control: private, no-store`.

After the vault key is unlocked, the browser validates the immutable encrypted manifest, requests the encrypted header, metadata and complete AES-GCM chunks, authenticates each chunk before exposing plaintext, and checks full-file SHA-256 when it processes the complete file. Cloudinary IDs, signed URLs, source files, plaintext names and plaintext key material are never returned by a browser API response.

## Preview allowlist

| Stored MIME and extension | Viewer |
| --- | --- |
| JPEG, PNG, WebP, GIF | Local object URL image |
| MP3, M4A, WAV, OGG | Local object URL audio element |
| PDF | Sandboxed local-object-URL iframe |
| TXT, LOG, CSV, JSON as `text/plain` | Escaped text only |
| SVG, HTML, DOCX, XLSX, PPTX, ZIP, RAR and unknown types | Download only |

Object URLs are revoked when the preview closes, the page unmounts, or `vaultx:key-clear` fires. Locking aborts in-flight ciphertext reads and removes plaintext UI. No decrypted output is added to a service worker cache, Cache Storage, IndexedDB, or local storage.

## Download behavior

The decrypted filename always uses the verified stored extension. Images and videos therefore download as their optimized stored WebP/JPEG/PNG or MP4 bytes; VaultX never claims to restore a source original.

On browsers with the File System Access API, the destination picker opens directly from the Download button and decrypted authenticated chunks stream to the selected file. VaultX closes the output only after every chunk and the full SHA-256 check pass. If decryption or validation fails it aborts the writable output. Browsers without that API use a temporary Blob only up to 32 MB; larger downloads fail clearly instead of building a giant plaintext buffer.

Encrypted MP4 playback/seek remains blocked by [VIDEO_STREAMING_BLOCKER.md](VIDEO_STREAMING_BLOCKER.md). Downloading a stored MP4 may work if the device supports the required save path, but it does not make the video playable inside VaultX.

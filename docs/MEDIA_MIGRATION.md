# Media migration gate

`npm run migration:media:dry-run` is a read-only inventory tool for the existing Atlas database and Cloudinary account. It never creates, updates, deletes, moves, downloads, uploads, or overwrites a MongoDB document or Cloudinary asset.

It writes a redacted JSON report to `reports/media-migration-dry-run.json`. The report is ignored by Git. It contains counts, collection names, field availability, duplicate reference counts, and provider verification states. It also inventories up to 10,000 Cloudinary assets across image, video, and raw delivery types and counts assets with no matching database reference. A partial or unavailable inventory is labeled honestly. It never contains filenames, Cloudinary public IDs, URLs, record IDs, passwords, access tokens, or credentials.

## Why there is no automatic legacy import

VaultX requires browser-side encryption before storage. A ready `files` document therefore requires all of these facts:

- an opaque `vaultx/ciphertext/*.dat` Cloudinary object of type `authenticated` and resource type `raw`;
- a verified Cloudinary asset ID and exact stored byte count;
- an authenticated encryption manifest;
- a wrapped file key; and
- encrypted filename, tag, and folder metadata.

Older Cloudinary image/video records such as `public_id`, `secure_url`, `original_filename`, and `thumbnail_url` cannot satisfy that contract. Copying them into `files` would falsely make public plaintext media look private. The audit marks those records `requires-client-reencryption` even when the Cloudinary object exists.

## Field mapping

| Existing field | VaultX destination | Rule |
| --- | --- | --- |
| `public_id`, `resource_type`, `type` | Cloudinary verification identity | Used only to verify a source asset. It is copied only for already-valid encrypted ciphertext. |
| `secure_url`, `thumbnail_url` | None | Not retained because VaultX does not store public delivery URLs. |
| `original_filename`, `display_name`, `tags` | encrypted name/tag envelopes | Requires browser-side unlock and encryption. |
| `bytes`, `width`, `height`, `duration`, `format` | verified stored metadata | Preserved only after the future importer checks Cloudinary's actual response. Missing data remains missing. |
| `albumId` | `folderId` | Requires a reviewed owner-scoped folder map. |
| `createdAt`, `updatedAt` | timestamps | Preserved only if valid. |

## Running the audit

```powershell
npm run migration:media:dry-run
```

To put the report at a different local path:

```powershell
npm run migration:media:dry-run -- --report reports\my-audit.json
```

The script prints progress counts only. You can safely rerun it after an interruption because it is read-only and creates no migration state or duplicate records.

## Interpreting results

- `already-compatible`: an existing VaultX encrypted record passed structural checks. Cloudinary still has to be verified before it can be considered available.
- `requires-client-reencryption`: an asset reference exists, but it is not safe to turn into a ready VaultX file.
- `missing-asset-reference`: media-like metadata has no usable Cloudinary public ID.
- `verified`, `missing`, and `inaccessible` describe the Cloudinary Admin API check. `inaccessible` is not a successful migration.

After reviewing the report, an approved follow-up can design a client-side re-encryption import. That workflow must retain the original source record and asset until the encrypted upload, provider verification, and destination metadata comparison are complete. Cleanup remains a separate explicit approval.

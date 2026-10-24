# Private gallery metadata on the existing Atlas database

The gallery uses the existing `MONGODB_URI`, `MONGODB_DB_NAME`, cached MongoDB client, and `files`/`folders` collections. Mongoose 9 attaches to the same driver pool; it does not create another Atlas database or connection pool. Model import does not create collections or indexes. Media queries use a bounded cursor (`createdAt`, `_id`), a projection, and lean documents. Names and tags are searched only after decryption in the unlocked browser.

| Requested field | Private VaultX mapping |
| --- | --- |
| `_id`, `albumId` | Existing file `_id`, owner-scoped `folderId`; albums are existing folders |
| `public_id`, `resource_type`, `format` | Server-only `cloudinary.publicId`, `resourceType`, `format`, with `assetId` and authenticated delivery type |
| `secure_url`, `thumbnail_url` | Not stored. Provider URLs must not become public media links. Existing encrypted thumbnail object identities remain server-only. |
| `bytes`, `width`, `height`, `duration` | Verified `storedSizeBytes` and optional media dimensions/duration |
| `original_filename`, `display_name` | `sourceNameEncrypted`, `nameEncrypted`; no plaintext names |
| `tags`, `favorite` | Optional encrypted tag envelopes and a boolean favorite flag |
| `deletionStatus` | Existing file `status` and durable `deletionJobs` lifecycle |
| Album `name`, `description`, `coverMediaId` | Encrypted folder name/optional description, optional file ID reference; cover content still requires normal owner authorization and file readiness checks |

The existing upload and deletion state machines still own writes. The new Mongoose models provide typed, read-only gallery listing; the favorite service delegates to the existing owner/folder-fenced file mutation. No API route or UI is added in this database step. The index definitions add a unique sparse Cloudinary public ID constraint plus date/filter indexes. They are **not created on Atlas by app startup**. Before running `npm run db:indexes`, review existing documents and index compatibility; an index build on an existing collection can fail if duplicate IDs already exist. The service does not run `syncIndexes`, which could remove existing indexes.

`npm run gallery:db-check` checks the shared connection and one-item read-only queries without returning file names or IDs. Unit tests cover validation, bounded paging, collection mapping and index declarations. This does not prove live insert/update/delete behavior or uniqueness enforcement on the existing Atlas collections. Those checks require disposable fixtures and an approved test procedure that will not disturb current data.

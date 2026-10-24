# VaultX backup and restore runbook

Status: **DESIGNED, NOT CONFIGURED OR RESTORE-TESTED** (2026-10-23). Use only disposable test files while [release gates](RELEASE_GATES.md) remain blocked. This runbook does not schedule backups or prove that any copy exists.

## What a recoverable backup needs

Keep three independently protected parts:

1. **Original photos and videos outside VaultX.** VaultX may retain only an optimized version. Keep the original files on your computer or phone and a second encrypted external/offsite copy that survives loss of that device. Check that files open from the second copy. Cloudinary is not the sole backup.
2. **MongoDB database archive plus Cloudinary ciphertext objects and inventory.** The database holds encrypted names, wrapped file keys, manifests, owner verifier, sessions, and upload/deletion jobs; it does not hold media bytes. A database dump alone cannot restore missing Cloudinary objects. A Cloudinary inventory alone cannot restore the bytes. Keep both from a consistent backup window.
3. **Owner-held vault passphrase and recovery key.** Save the recovery key when first shown, separately from the encrypted backup. A database and ciphertext restore without either valid vault unlock method cannot decrypt files. Do not put the key, login password, or provider credentials in the backup inventory, Git, chat, or screenshots.

Use at least two copies on different devices, with one offline or offsite. Encrypt backup disks or archives with a separately managed backup key, restrict access, and keep a version from before an accidental deletion. Do not sync an unencrypted database dump to a public drive. The dump contains sensitive authentication and encrypted-key material even though filenames are encrypted.

## Scheduled procedure to configure

No scheduler is installed. After a disposable-file restore rehearsal passes, configure a trusted external backup runner or calendar reminder. Daily database export and weekly original/ciphertext inventory and copy are starting intervals; choose retention based on how much loss you can tolerate. Keep several dated versions and document the actual schedule, storage location, encryption method, retention, and last successful verification **outside this repository**.

1. Before exporting, check **Uploads** and **Deletions**. Record counts of `ready`, pending uploads, and pending/failed deletions without filenames or IDs in public logs. A pending job makes a point-in-time copy ambiguous; wait for completion or explicitly record it for reconciliation after restore.
2. Install **MongoDB Database Tools** on a trusted backup computer. The official [`mongodump` guide](https://www.mongodb.com/docs/database-tools/mongodump/) supports `--config` for a protected YAML file containing `uri`; this keeps the connection string out of the command line. Put that file **outside `D:\VaultX` and outside Git** with permissions limited to your account. Reuse the current Atlas URI and database; do not create replacement credentials or a new cluster for this step.
3. Export an archive, for example in PowerShell (replace only the placeholder paths and database name locally):

   ```powershell
   mongodump --config="C:\private\vaultx-mongodump.yml" --db="YOUR_EXISTING_DB_NAME" --gzip --archive="E:\VaultX-backups\vaultx-YYYY-MM-DD.archive.gz"
   ```

   The protected YAML file contains `uri: "<your existing MONGODB_URI>"`. Never paste the real URI into the terminal command or this repository. Check the exit code and that the archive is nonempty, then encrypt the archive for storage. Do not delete a prior good copy when a new dump fails. [Atlas backup documentation](https://www.mongodb.com/docs/atlas/backup-restore-cluster/) describes manual dump/restore for Free clusters; Atlas documentation about optional Free-cluster snapshots varies, so check your **actual cluster's** Backup page. No Atlas snapshot is assumed to be enabled here.
4. With the existing server-side Cloudinary credentials, export a paginated **Admin API inventory** of VaultX's exact `raw/authenticated` objects: public ID, immutable asset ID, delivery type, resource type, stored byte count, and backup timestamp. Protect this inventory as private metadata. The account contains other pre-existing assets; do not delete, rename, overwrite, or include them in an automatic VaultX restore. Cloudinary's [Admin API](https://cloudinary.com/documentation/admin_api) is rate-limited. An inventory is **not** an asset-byte backup: additionally copy the encrypted object bytes through an authorized route to independently encrypted storage, or retain verified original files separately. Do not use unsigned public delivery URLs or weaken `authenticated` mode to make a bulk export easier. Cloudinary's [asset download guidance](https://cloudinary.com/documentation/ts_how_can_i_download_my_accounts_assets) describes account export options; verify access controls for this exact delivery mode before using one.
5. Save a private manifest of backup date, database archive hash, number of ready records, inventory count, ciphertext copy count, total stored bytes, and encrypted backup location. Never write raw IDs or filenames to application logs. Keep the manifest with the encrypted backup, not in Git.

## Verification and accidental-deletion protection

- Every backup run: confirm the job exited successfully, files exist, sizes are plausible, hashes match after copying, and the encrypted destination can be opened with its separate backup key. Alert on missing or stale runs.
- Monthly: restore the database archive to an **isolated disposable database**, never over the live database, and compare collection counts and a sample of encrypted metadata. Check that sampled Cloudinary ciphertext objects match their inventory byte counts. Recover a disposable file in a fresh browser using the separately stored vault recovery key and compare its decrypted bytes with the expected sample. Record date and result without private content.
- Before mass deletion or schema migration: make and verify a fresh versioned backup. Require explicit selection and confirmation in VaultX; monitor the durable deletion jobs. A successfully completed VaultX deletion removes active Atlas records and Cloudinary objects; a backup's retained copy may survive until its own retention expires. Keep backup retention separate from active-store deletion claims.
- Keep original-photo backups and backup credentials independent of the same Cloudinary account. Account loss, quota exhaustion, or accidental provider deletion must not remove every copy.

## Restore rehearsal, then disaster restore

1. Stop writes/uploads and identify the last verified matching set of database archive, Cloudinary ciphertext copy/inventory, original-file backup, and recovery key. Record any pending deletion/upload jobs from the backup point. Do not restore directly into the existing live collections or overwrite any current Cloudinary asset.
2. In a separate test database with access limited to the operator, restore the archive with [MongoDB Database Tools](https://www.mongodb.com/docs/database-tools/mongorestore/). Use its protected config file and `--gzip --archive="..."`; point it at the **test** database/cluster and inspect the namespace mapping before running. Avoid `--drop` against the production database. Verify collection counts, owner uniqueness, indexes, and encrypted-key envelope presence.
3. Compare every referenced Cloudinary object identity and byte count against the inventory and copied ciphertext. For missing objects, recover ciphertext from the independent backup into a **separate approved Cloudinary namespace/account or staging environment**. Keep the exact identity mapping; updating references requires a reviewed migration, not a blind reupload. Do not restore plaintext originals to public delivery.
4. In a fresh browser against the isolated environment, unlock with the saved vault passphrase or recovery key. Download and compare a disposable file, then test a photo preview and authorized ciphertext range. Verify anonymous provider access is denied. Confirm deletion jobs do not accidentally resume against the live account; enable reconciliation only after reviewing their target identities.
5. Promote the restore only after its counts, identities, decrypted sample, authentication, lock, and deletion behavior pass. Choose a controlled cutover with a new database/host configuration and owner approval. Preserve the old system until the new one is verified. If any part fails, keep production writes stopped and the release status **BLOCKED**.

**Current blocker:** `mongodump` is not installed on this computer, no automatic export or independent ciphertext backup was found/configured, and no restore drill has been run. A copy of originals is the immediate protection for important media.

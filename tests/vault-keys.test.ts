import assert from "node:assert/strict";
import test from "node:test";
import { ObjectId } from "mongodb";
import { deriveVaultPasswordKey } from "../src/lib/crypto/argon2-browser";
import { createVaultKeys, rotateVaultPassphrase, unlockVaultWithPassphrase, unlockVaultWithRecovery, VaultKeyError } from "../src/lib/crypto/vault-keys";
import { vaultKeyEnvelopeSchema } from "../src/lib/crypto/vault-key-schema";
import { vaultKeyRecordSchema } from "../src/lib/database/models";
import { modelIndexes } from "../src/lib/database/model-indexes";

const passphrase = "independent-long-vault-passphrase-2026";

test("weak vault passphrases are refused before key setup", async () => {
  await assert.rejects(createVaultKeys("aaaaaaaaaaaaaaaaaaaaaaaa", deriveVaultPasswordKey),
    (error: unknown) => error instanceof VaultKeyError && error.code === "invalid_unlock");
});

test("setup creates two independent encrypted backups; recovery works from a serialized fresh context", async () => {
  const generated = await createVaultKeys(passphrase, deriveVaultPasswordKey);
  try {
    assert.equal(vaultKeyEnvelopeSchema.safeParse(generated.envelope).success, true);
    const serialized = JSON.stringify(generated.envelope);
    assert.equal(serialized.includes(passphrase), false);
    assert.equal(serialized.includes(generated.recoveryCode), false);
    assert.equal(serialized.includes(Buffer.from(generated.rootKey).toString("base64url")), false);

    // A second browser receives only the serialized server envelope and the
    // owner's offline recovery code, with no shared in-memory key state.
    const secondBrowserEnvelope: unknown = JSON.parse(serialized);
    const recovered = await unlockVaultWithRecovery(secondBrowserEnvelope, generated.recoveryCode);
    assert.deepEqual(recovered, generated.rootKey);
    recovered.fill(0);
    const byPassphrase = await unlockVaultWithPassphrase(secondBrowserEnvelope, passphrase, deriveVaultPasswordKey);
    assert.deepEqual(byPassphrase, generated.rootKey);
    byPassphrase.fill(0);

    await assert.rejects(unlockVaultWithPassphrase(secondBrowserEnvelope, "this-is-the-wrong-vault-password", deriveVaultPasswordKey),
      (error: unknown) => error instanceof VaultKeyError && error.code === "invalid_unlock");
    await assert.rejects(unlockVaultWithRecovery(secondBrowserEnvelope, "A".repeat(43)),
      (error: unknown) => error instanceof VaultKeyError && error.code === "invalid_unlock");
  } finally { generated.rootKey.fill(0); }
});

test("tampered envelopes and missing migration metadata fail closed", async () => {
  const generated = await createVaultKeys(passphrase, deriveVaultPasswordKey);
  try {
    const envelope = generated.envelope;
    const flip = (value: string) => `${value[0] === "A" ? "B" : "A"}${value.slice(1)}`;
    await assert.rejects(unlockVaultWithPassphrase({ ...envelope, password: { ...envelope.password, ciphertext: flip(envelope.password.ciphertext) } }, passphrase, deriveVaultPasswordKey),
      (error: unknown) => error instanceof VaultKeyError && error.code === "invalid_unlock");
    await assert.rejects(unlockVaultWithRecovery({ ...envelope, recovery: { ...envelope.recovery, ciphertext: flip(envelope.recovery.ciphertext) } }, generated.recoveryCode),
      (error: unknown) => error instanceof VaultKeyError && error.code === "invalid_unlock");
    await assert.rejects(unlockVaultWithRecovery({ ...envelope, vaultId: flip(envelope.vaultId) }, generated.recoveryCode),
      (error: unknown) => error instanceof VaultKeyError && ["invalid_unlock", "migration_required"].includes(error.code));
    await assert.rejects(unlockVaultWithRecovery({ ...envelope, version: 0 }, generated.recoveryCode),
      (error: unknown) => error instanceof VaultKeyError && error.code === "migration_required");
    await assert.rejects(unlockVaultWithRecovery({ version: 1 }, generated.recoveryCode),
      (error: unknown) => error instanceof VaultKeyError && error.code === "migration_required");
    assert.equal(vaultKeyEnvelopeSchema.safeParse({ ...envelope, rootKey: "plaintext" }).success, false);
    assert.equal(vaultKeyEnvelopeSchema.safeParse({ ...envelope, password: { ...envelope.password, memoryKiB: 1 } }).success, false);
  } finally { generated.rootKey.fill(0); }
});

test("database schema keeps only encrypted envelopes and has a unique owner index", async () => {
  const generated = await createVaultKeys(passphrase, deriveVaultPasswordKey);
  try {
    const record = { ...generated.envelope, _id: new ObjectId(), ownerId: new ObjectId(), createdAt: new Date(), recoveryConfirmedAt: new Date() };
    assert.equal(vaultKeyRecordSchema.safeParse(record).success, true);
    assert.equal(vaultKeyRecordSchema.safeParse({ ...record, recoveryCode: generated.recoveryCode }).success, false);
    assert.equal(vaultKeyRecordSchema.safeParse({ ...record, passphrase }).success, false);
    assert.equal(modelIndexes.vaultKeys[0].unique, true);
    assert.deepEqual(modelIndexes.vaultKeys[0].key, { ownerId: 1 });
  } finally { generated.rootKey.fill(0); }
});

test("passphrase rotation rewraps the same master key and preserves independent recovery", async () => {
  const generated = await createVaultKeys(passphrase, deriveVaultPasswordKey);
  const newPassphrase = "different-strong-vault-passphrase-2031";
  try {
    const rotated = await rotateVaultPassphrase(generated.envelope, passphrase, newPassphrase, deriveVaultPasswordKey);
    assert.equal(rotated.revision, 2);
    assert.equal(rotated.vaultId, generated.envelope.vaultId);
    assert.deepEqual(rotated.recovery, generated.envelope.recovery);
    assert.notDeepEqual(rotated.password, generated.envelope.password);
    await assert.rejects(unlockVaultWithPassphrase(rotated, passphrase, deriveVaultPasswordKey),
      (error: unknown) => error instanceof VaultKeyError && error.code === "invalid_unlock");
    const unlocked = await unlockVaultWithPassphrase(rotated, newPassphrase, deriveVaultPasswordKey);
    const recovered = await unlockVaultWithRecovery(rotated, generated.recoveryCode);
    assert.deepEqual(unlocked, generated.rootKey);
    assert.deepEqual(recovered, generated.rootKey);
    unlocked.fill(0); recovered.fill(0);
    await assert.rejects(rotateVaultPassphrase(generated.envelope, "incorrect-old-vault-passphrase", newPassphrase, deriveVaultPasswordKey));
    assert.equal(vaultKeyEnvelopeSchema.safeParse({ ...rotated, revision: 0 }).success, false);
  } finally { generated.rootKey.fill(0); }
});

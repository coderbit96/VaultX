import { VAULT_KDF, vaultKeyEnvelopeSchema, type VaultKeyEnvelope } from "./vault-key-schema";

export type PasswordDeriver = (password: Uint8Array, salt: Uint8Array) => Promise<Uint8Array>;
export type VaultKeyErrorCode = "invalid_unlock" | "migration_required" | "crypto_unavailable";

export class VaultKeyError extends Error {
  constructor(readonly code: VaultKeyErrorCode) {
    super(code);
    this.name = "VaultKeyError";
  }
}

function bytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

function encode(data: Uint8Array): string {
  return btoa(String.fromCharCode(...data)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decode(value: string, length: number): Uint8Array {
  try {
    const raw = atob(value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4));
    const result = Uint8Array.from(raw, (character) => character.charCodeAt(0));
    if (result.length !== length || encode(result) !== value) throw new Error();
    return result;
  } catch {
    throw new VaultKeyError("migration_required");
  }
}

function join(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}

function context(domain: string, vaultId: Uint8Array): Uint8Array {
  const revision = new Uint8Array([0, 0, 0, 1]);
  return join(new TextEncoder().encode(`${domain}\0`), vaultId, revision);
}

function passwordBytes(passphrase: string): Uint8Array {
  if ([...passphrase].length < 16 || passphrase.length > 1024 || /[\p{Cc}\p{Cf}]/u.test(passphrase)) {
    throw new VaultKeyError("invalid_unlock");
  }
  const result = new TextEncoder().encode(passphrase);
  if (result.length > 4096) throw new VaultKeyError("invalid_unlock");
  return result;
}

async function assertStrongPassphrase(passphrase: string, password: Uint8Array): Promise<void> {
  try {
    const [{ ZxcvbnFactory }, common, english] = await Promise.all([
      import("@zxcvbn-ts/core"), import("@zxcvbn-ts/language-common"), import("@zxcvbn-ts/language-en"),
    ]);
    const strength = new ZxcvbnFactory({
      dictionary: { ...common.dictionary, ...english.dictionary },
      graphs: common.adjacencyGraphs,
      translations: english.translations,
      useLevenshteinDistance: true,
    }).check(passphrase, ["vaultx", "owner"]);
    if (strength.score < 3) throw new VaultKeyError("invalid_unlock");
  } catch (error) {
    password.fill(0);
    if (error instanceof VaultKeyError) throw error;
    throw new VaultKeyError("crypto_unavailable");
  }
}

async function aesEncrypt(keyBytes: Uint8Array, nonce: Uint8Array, aad: Uint8Array, plaintext: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", keyBytes as BufferSource, "AES-GCM", false, ["encrypt"]);
  return new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce as BufferSource, additionalData: aad as BufferSource, tagLength: 128 }, key, plaintext as BufferSource));
}

async function aesDecrypt(keyBytes: Uint8Array, nonce: Uint8Array, aad: Uint8Array, ciphertext: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", keyBytes as BufferSource, "AES-GCM", false, ["decrypt"]);
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce as BufferSource, additionalData: aad as BufferSource, tagLength: 128 }, key, ciphertext as BufferSource));
}

async function recoveryWrapKey(secret: Uint8Array, salt: Uint8Array, vaultId: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", secret as BufferSource, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({
    name: "HKDF", hash: "SHA-256", salt: salt as BufferSource,
    info: context("VaultX/recovery-wrap/v1", vaultId) as BufferSource,
  }, key, 256));
}

function parseEnvelope(value: unknown): VaultKeyEnvelope {
  const parsed = vaultKeyEnvelopeSchema.safeParse(value);
  if (!parsed.success) throw new VaultKeyError("migration_required");
  // Zod checks shape and encoded length; canonical decoding closes base64 aliases.
  decode(parsed.data.vaultId, 16);
  decode(parsed.data.password.salt, 16);
  decode(parsed.data.password.nonce, 12);
  decode(parsed.data.password.ciphertext, 48);
  decode(parsed.data.recovery.salt, 32);
  decode(parsed.data.recovery.nonce, 12);
  decode(parsed.data.recovery.ciphertext, 48);
  return parsed.data;
}

export async function createVaultKeys(passphrase: string, derive: PasswordDeriver): Promise<{
  envelope: VaultKeyEnvelope;
  recoveryCode: string;
  rootKey: Uint8Array;
}> {
  const password = passwordBytes(passphrase);
  await assertStrongPassphrase(passphrase, password);
  const rootKey = bytes(32);
  const recoverySecret = bytes(32);
  const vaultId = bytes(16);
  const passwordSalt = bytes(16);
  const passwordNonce = bytes(12);
  const recoverySalt = bytes(32);
  const recoveryNonce = bytes(12);
  let passwordKey: Uint8Array | undefined;
  let recoveryKey: Uint8Array | undefined;
  try {
    passwordKey = await derive(password, passwordSalt);
    if (passwordKey.length !== 32) throw new Error();
    recoveryKey = await recoveryWrapKey(recoverySecret, recoverySalt, vaultId);
    const [passwordCiphertext, recoveryCiphertext] = await Promise.all([
      aesEncrypt(passwordKey, passwordNonce, context("VaultX/passphrase-wrap/v1", vaultId), rootKey),
      aesEncrypt(recoveryKey, recoveryNonce, context("VaultX/recovery-wrap/v1", vaultId), rootKey),
    ]);
    // Verify both independently usable backups before sending any envelope.
    const [passwordCheck, recoveryCheck] = await Promise.all([
      aesDecrypt(passwordKey, passwordNonce, context("VaultX/passphrase-wrap/v1", vaultId), passwordCiphertext),
      aesDecrypt(recoveryKey, recoveryNonce, context("VaultX/recovery-wrap/v1", vaultId), recoveryCiphertext),
    ]);
    if (passwordCheck.length !== 32 || recoveryCheck.length !== 32
      || !passwordCheck.every((byte, index) => byte === rootKey[index])
      || !recoveryCheck.every((byte, index) => byte === rootKey[index])) throw new Error();
    passwordCheck.fill(0);
    recoveryCheck.fill(0);
    const envelope = parseEnvelope({
      version: 1, vaultId: encode(vaultId), revision: 1,
      password: { kdf: VAULT_KDF, salt: encode(passwordSalt), nonce: encode(passwordNonce), ciphertext: encode(passwordCiphertext) },
      recovery: { algorithm: "HKDF-SHA-256/AES-256-GCM", salt: encode(recoverySalt), nonce: encode(recoveryNonce), ciphertext: encode(recoveryCiphertext) },
    });
    return { envelope, recoveryCode: encode(recoverySecret), rootKey };
  } catch {
    rootKey.fill(0);
    throw new VaultKeyError("crypto_unavailable");
  } finally {
    password.fill(0);
    passwordKey?.fill(0);
    recoveryKey?.fill(0);
    recoverySecret.fill(0);
  }
}

// Rewraps only the 32-byte vault master key. File keys, ciphertext objects and
// the independent recovery backup retain their existing identities.
export async function rotateVaultPassphrase(
  value: unknown, oldPassphrase: string, newPassphrase: string, derive: PasswordDeriver,
): Promise<VaultKeyEnvelope> {
  const current = parseEnvelope(value);
  if (current.revision >= 2_147_483_647 || oldPassphrase === newPassphrase) throw new VaultKeyError("invalid_unlock");
  const root = await unlockVaultWithPassphrase(current, oldPassphrase, derive);
  let password: Uint8Array | undefined;
  let wrappingKey: Uint8Array | undefined;
  try {
    password = passwordBytes(newPassphrase);
    await assertStrongPassphrase(newPassphrase, password);
    const salt = bytes(16);
    const nonce = bytes(12);
    const vaultId = decode(current.vaultId, 16);
    wrappingKey = await derive(password, salt);
    if (wrappingKey.length !== 32) throw new VaultKeyError("crypto_unavailable");
    const ciphertext = await aesEncrypt(wrappingKey, nonce, context("VaultX/passphrase-wrap/v1", vaultId), root);
    const verified = await aesDecrypt(wrappingKey, nonce, context("VaultX/passphrase-wrap/v1", vaultId), ciphertext);
    try {
      if (!verified.every((byte, index) => byte === root[index])) throw new VaultKeyError("crypto_unavailable");
    } finally { verified.fill(0); }
    return parseEnvelope({
      ...current,
      revision: current.revision + 1,
      password: { kdf: VAULT_KDF, salt: encode(salt), nonce: encode(nonce), ciphertext: encode(ciphertext) },
    });
  } finally { root.fill(0); password?.fill(0); wrappingKey?.fill(0); }
}

export async function unlockVaultWithPassphrase(value: unknown, passphrase: string, derive: PasswordDeriver): Promise<Uint8Array> {
  const envelope = parseEnvelope(value);
  const password = passwordBytes(passphrase);
  const salt = decode(envelope.password.salt, 16);
  let key: Uint8Array;
  try { key = await derive(password, salt); }
  catch { throw new VaultKeyError("crypto_unavailable"); }
  finally { password.fill(0); }
  try {
    const root = await aesDecrypt(key, decode(envelope.password.nonce, 12),
      context("VaultX/passphrase-wrap/v1", decode(envelope.vaultId, 16)), decode(envelope.password.ciphertext, 48));
    if (root.length !== 32) throw new Error();
    return root;
  } catch { throw new VaultKeyError("invalid_unlock"); }
  finally { key.fill(0); }
}

export async function unlockVaultWithRecovery(value: unknown, recoveryCode: string): Promise<Uint8Array> {
  const envelope = parseEnvelope(value);
  let secret: Uint8Array;
  try { secret = decode(recoveryCode.trim(), 32); }
  catch { throw new VaultKeyError("invalid_unlock"); }
  let key: Uint8Array | undefined;
  try {
    const vaultId = decode(envelope.vaultId, 16);
    key = await recoveryWrapKey(secret, decode(envelope.recovery.salt, 32), vaultId);
    const root = await aesDecrypt(key, decode(envelope.recovery.nonce, 12),
      context("VaultX/recovery-wrap/v1", vaultId), decode(envelope.recovery.ciphertext, 48));
    if (root.length !== 32) throw new Error();
    return root;
  } catch { throw new VaultKeyError("invalid_unlock"); }
  finally { secret.fill(0); key?.fill(0); }
}

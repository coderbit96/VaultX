import { encryptedNameSchema, type EncryptedFolderName } from "./folder-name-schema";
import { assertVaultKeyActive, leaseVaultRootKey } from "./key-memory";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const info = encoder.encode("VaultX/folder-name/v1\0");
const aadPrefix = encoder.encode("VaultX/folder-name-aad/v1\0");
const idPattern = /^[a-f0-9]{24}$/;

function join(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}
function encode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function decode(value: string, length: number | [number, number]): Uint8Array {
  try {
    const raw = atob(value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4));
    const result = Uint8Array.from(raw, (character) => character.charCodeAt(0));
    if ((typeof length === "number" ? result.length !== length : result.length < length[0] || result.length > length[1]) || encode(result) !== value) throw new Error();
    return result;
  } catch { throw new Error("Invalid encrypted folder name"); }
}
function folderIdBytes(folderId: string): Uint8Array {
  if (!idPattern.test(folderId)) throw new Error("Invalid folder ID");
  return Uint8Array.from({ length: 12 }, (_, index) => Number.parseInt(folderId.slice(index * 2, index * 2 + 2), 16));
}
function validateName(name: string): Uint8Array {
  const normalized = name.normalize("NFC").trim();
  if (!normalized || [...normalized].length > 120 || /[\p{Cc}\p{Cf}]/u.test(normalized) || normalized === "." || normalized === "..") {
    throw new Error("Invalid folder name");
  }
  const bytes = encoder.encode(normalized);
  if (bytes.length > 480) throw new Error("Invalid folder name");
  return bytes;
}
async function derive(root: Uint8Array, salt: Uint8Array, vaultId: Uint8Array, folderId: Uint8Array): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", root as BufferSource, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: salt as BufferSource,
    info: join(info, vaultId, folderId) as BufferSource }, material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
export function newFolderId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(12)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
export async function encryptFolderName(folderId: string, name: string): Promise<EncryptedFolderName> {
  const id = folderIdBytes(folderId);
  const plain = validateName(name);
  const lease = leaseVaultRootKey();
  try {
    const salt = crypto.getRandomValues(new Uint8Array(32));
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const vaultId = decode(lease.vaultId, 16);
    const key = await derive(lease.key, salt, vaultId, id);
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce as BufferSource,
      additionalData: join(aadPrefix, vaultId, id) as BufferSource, tagLength: 128 }, key, plain as BufferSource));
    assertVaultKeyActive(lease.generation, lease.vaultId);
    return encryptedNameSchema.parse({ version: 1, vaultId: lease.vaultId, salt: encode(salt), nonce: encode(nonce),
      ciphertext: encode(ciphertext), algorithm: "AES-256-GCM" });
  } finally { plain.fill(0); lease.release(); }
}
export async function decryptFolderName(folderId: string, input: unknown): Promise<string> {
  const id = folderIdBytes(folderId);
  const parsed = encryptedNameSchema.safeParse(input);
  if (!parsed.success) throw new Error("Invalid encrypted folder name");
  const lease = leaseVaultRootKey();
  try {
    if (lease.vaultId !== parsed.data.vaultId) throw new Error("Wrong vault key");
    const vaultId = decode(parsed.data.vaultId, 16);
    const key = await derive(lease.key, decode(parsed.data.salt, 32), vaultId, id);
    const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: decode(parsed.data.nonce, 12) as BufferSource,
      additionalData: join(aadPrefix, vaultId, id) as BufferSource, tagLength: 128 }, key, decode(parsed.data.ciphertext, [17, 496]) as BufferSource));
    try {
      assertVaultKeyActive(lease.generation, lease.vaultId);
      const name = decoder.decode(plain);
      if (decoder.decode(validateName(name)) !== name) throw new Error("Invalid folder name");
      return name;
    } finally { plain.fill(0); }
  } catch { throw new Error("Folder name could not be decrypted"); }
  finally { lease.release(); }
}

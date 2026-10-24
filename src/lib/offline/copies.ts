import { authenticatedCiphertextSource } from "../files/decrypt-client";
import { openEncryptedContainer, type CiphertextSource } from "../crypto/file-container";
import { assertVaultKeyActive, leaseVaultRootKey } from "../crypto/key-memory";
import { vaultKeyEnvelopeSchema, type VaultKeyEnvelope } from "../crypto/vault-key-schema";
import type { FileAccessMetadata } from "../files/types";

const DB_NAME = "vaultx-encrypted-offline-v1";
const BLOCK = 1_048_576;
const MAX_COPIES_BYTES = 500_000_000;

export type OfflineCopy = { id: string; copyId: string; sealed: Uint8Array; nonce: Uint8Array };
export type OfflineDetails = FileAccessMetadata;

function request<T>(operation: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    operation.onsuccess = () => resolve(operation.result);
    operation.onerror = () => reject(operation.error ?? new Error("Offline storage failed"));
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error("Offline storage was interrupted"));
    tx.onerror = () => reject(tx.error ?? new Error("Offline storage failed"));
  });
}

export async function openOfflineDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") throw new Error("IndexedDB is unavailable on this device");
  const opening = indexedDB.open(DB_NAME, 1);
  opening.onupgradeneeded = () => {
    const db = opening.result;
    db.createObjectStore("copies", { keyPath: "id" });
    db.createObjectStore("blocks");
    db.createObjectStore("settings");
  };
  const db = await request(opening);
  db.onversionchange = () => db.close();
  return db;
}

async function put(db: IDBDatabase, store: string, key: IDBValidKey, value: unknown): Promise<void> {
  const tx = db.transaction(store, "readwrite");
  tx.objectStore(store).put(value, key);
  await transactionDone(tx);
}

async function removeBlocks(db: IDBDatabase, copyId: string): Promise<void> {
  const range = IDBKeyRange.bound(`${copyId}:`, `${copyId}:\uffff`);
  const keys = await request(db.transaction("blocks").objectStore("blocks").getAllKeys(range));
  if (keys.length === 0) return;
  const tx = db.transaction("blocks", "readwrite");
  for (const key of keys) tx.objectStore("blocks").delete(key);
  await transactionDone(tx);
}

export async function listOfflineCopies(): Promise<OfflineCopy[]> {
  const db = await openOfflineDb();
  try { return await request(db.transaction("copies").objectStore("copies").getAll()) as OfflineCopy[]; }
  finally { db.close(); }
}

export async function getOfflineEnvelope(): Promise<VaultKeyEnvelope | null> {
  const db = await openOfflineDb();
  try {
    const value: unknown = await request(db.transaction("settings").objectStore("settings").get("envelope"));
    return value == null ? null : vaultKeyEnvelopeSchema.parse(value);
  } finally { db.close(); }
}

export async function removeOfflineCopy(id: string): Promise<void> {
  const db = await openOfflineDb();
  try {
    const tx = db.transaction(["copies", "settings"], "readwrite");
    const copies = tx.objectStore("copies");
    const copyRequest = copies.get(id);
    let copy: OfflineCopy | undefined;
    copyRequest.onsuccess = () => {
      copy = copyRequest.result as OfflineCopy | undefined;
      copies.delete(id);
      tx.objectStore("settings").put(crypto.randomUUID(), `removed:${id}`);
    };
    await transactionDone(tx);
    if (copy) await removeBlocks(db, copy.copyId);
  } finally { db.close(); }
}

export async function clearOfflineCopies(): Promise<void> {
  const db = await openOfflineDb();
  try {
    const tx = db.transaction(["copies", "blocks", "settings"], "readwrite");
    tx.objectStore("copies").clear();
    tx.objectStore("blocks").clear();
    tx.objectStore("settings").clear();
    tx.objectStore("settings").put(crypto.randomUUID(), "epoch");
    await transactionDone(tx);
  } finally { db.close(); }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event("vaultx:offline-clear"));
    if ("BroadcastChannel" in window) {
      const channel = new BroadcastChannel("vaultx-offline-clear"); channel.postMessage("clear"); channel.close();
    }
  }
}

async function seal(file: FileAccessMetadata): Promise<{ sealed: Uint8Array; nonce: Uint8Array; vaultId: string }> {
  const lease = leaseVaultRootKey();
  try {
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const key = await crypto.subtle.importKey("raw", lease.key as BufferSource, "AES-GCM", false, ["encrypt"]);
    const bytes = new TextEncoder().encode(JSON.stringify(file));
    try {
      const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce as BufferSource,
        additionalData: new TextEncoder().encode(`VaultX/offline-metadata/v1/${lease.vaultId}/${file.id}`) as BufferSource }, key, bytes as BufferSource));
      assertVaultKeyActive(lease.generation, lease.vaultId);
      return { sealed, nonce, vaultId: lease.vaultId };
    } finally { bytes.fill(0); }
  } finally { lease.release(); }
}

export async function openOfflineDetails(copy: OfflineCopy): Promise<OfflineDetails> {
  const lease = leaseVaultRootKey();
  try {
    const key = await crypto.subtle.importKey("raw", lease.key as BufferSource, "AES-GCM", false, ["decrypt"]);
    const bytes = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: copy.nonce as BufferSource,
      additionalData: new TextEncoder().encode(`VaultX/offline-metadata/v1/${lease.vaultId}/${copy.id}`) as BufferSource }, key, copy.sealed as BufferSource));
    try {
      assertVaultKeyActive(lease.generation, lease.vaultId);
      const parsed = JSON.parse(new TextDecoder().decode(bytes)) as OfflineDetails;
      if (parsed.id !== copy.id || !Number.isSafeInteger(parsed.storedSizeBytes) || parsed.storedSizeBytes <= 0
        || parsed.encryptionManifest.objectBytes !== String(parsed.storedSizeBytes) || parsed.encryptionManifest.vaultId !== lease.vaultId) throw new Error("Offline metadata mismatch");
      return parsed;
    } finally { bytes.fill(0); }
  } finally { lease.release(); }
}

export async function offlineCiphertextSource(copy: OfflineCopy, size: number): Promise<CiphertextSource> {
  if (!Number.isSafeInteger(size) || size <= 0) throw new Error("Invalid offline size");
  return { size: BigInt(size), async read(start, endExclusive) {
    if (start < BigInt(0) || endExclusive <= start || endExclusive > BigInt(size) || endExclusive - start > BigInt(BLOCK + 16)) throw new Error("Invalid offline range");
    const db = await openOfflineDb();
    try {
      const first = Math.floor(Number(start) / BLOCK);
      const last = Math.floor((Number(endExclusive) - 1) / BLOCK);
      const joined = new Uint8Array(Number(endExclusive - start));
      for (let index = first; index <= last; index += 1) {
        const part = await request(db.transaction("blocks").objectStore("blocks").get(`${copy.copyId}:${index}`)) as Uint8Array | undefined;
        if (!part || part.length !== Math.min(BLOCK, size - index * BLOCK)) throw new Error("Offline copy was evicted or incomplete");
        const from = Math.max(Number(start), index * BLOCK);
        const to = Math.min(Number(endExclusive), (index + 1) * BLOCK);
        joined.set(part.subarray(from - index * BLOCK, to - index * BLOCK), from - Number(start));
      }
      return joined;
    } finally { db.close(); }
  } };
}

export async function saveOfflineCopy(file: FileAccessMetadata, envelope: VaultKeyEnvelope,
  onProgress?: (done: number, total: number) => void, signal?: AbortSignal): Promise<void> {
  if (!navigator.onLine) throw new Error("Connect to save an offline copy");
  if (file.encryptionManifest.vaultId !== envelope.vaultId) throw new Error("Vault key mismatch");
  const existing = await listOfflineCopies();
  const gateDb = await openOfflineDb();
  let gate: { epoch: unknown; removed: unknown };
  try {
    const tx = gateDb.transaction("settings");
    const store = tx.objectStore("settings");
    gate = { epoch: await request(store.get("epoch")), removed: await request(gateDb.transaction("settings").objectStore("settings").get(`removed:${file.id}`)) };
  } finally { gateDb.close(); }
  let total = file.storedSizeBytes;
  for (const item of existing) if (item.id !== file.id) total += (await openOfflineDetails(item)).storedSizeBytes;
  if (total > MAX_COPIES_BYTES) {
    throw new Error("Offline copies exceed the 500 MB app limit. Remove another copy first.");
  }
  const quota = await navigator.storage?.estimate?.();
  if (quota?.quota && quota.usage && quota.quota - quota.usage < file.storedSizeBytes * 1.1) throw new Error("Browser storage is nearly full");
  const sealed = await seal(file);
  const copyId = crypto.randomUUID();
  const blocks = Math.ceil(file.storedSizeBytes / BLOCK);
  const source = authenticatedCiphertextSource(file.id, file.storedSizeBytes, signal);
  const db = await openOfflineDb();
  try {
    for (let index = 0; index < blocks; index += 1) {
      if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
      const start = BigInt(index * BLOCK);
      const end = BigInt(Math.min(file.storedSizeBytes, (index + 1) * BLOCK));
      const bytes = await source.read(start, end);
      await put(db, "blocks", `${copyId}:${index}`, bytes);
      bytes.fill(0);
      onProgress?.(Number(end), file.storedSizeBytes);
    }
    const provisional: OfflineCopy = { id: file.id, copyId, sealed: sealed.sealed, nonce: sealed.nonce };
    const opened = await openEncryptedContainer(await offlineCiphertextSource(provisional, file.storedSizeBytes), file.encryptionManifest, signal);
    try { for await (const chunk of opened.chunks()) chunk.fill(0); }
    finally { opened.close(); }
    if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
    const lease = leaseVaultRootKey();
    try {
      if (lease.vaultId !== sealed.vaultId) throw new Error("Vault key changed while saving offline copy");
      assertVaultKeyActive(lease.generation, lease.vaultId);
    } finally { lease.release(); }
    const old = existing.find((item) => item.id === file.id);
    const tx = db.transaction(["settings", "copies"], "readwrite");
    const settings = tx.objectStore("settings");
    const epochRequest = settings.get("epoch");
    const removedRequest = settings.get(`removed:${file.id}`);
    const currentRequest = tx.objectStore("copies").get(file.id);
    let checked = 0;
    let stale = false;
    const check = () => {
      checked += 1;
      if (checked !== 3) return;
      const current = currentRequest.result as OfflineCopy | undefined;
      if (epochRequest.result !== gate.epoch || removedRequest.result !== gate.removed
        || current?.copyId !== old?.copyId || signal?.aborted) {
        stale = true; tx.abort(); return;
      }
      settings.put(envelope, "envelope");
      settings.delete(`removed:${file.id}`);
      tx.objectStore("copies").put(provisional);
    };
    epochRequest.onsuccess = check;
    removedRequest.onsuccess = check;
    currentRequest.onsuccess = check;
    try { await transactionDone(tx); }
    catch (error) { if (stale) throw new Error("Offline selection was cleared or removed while saving"); throw error; }
    if (old) await removeBlocks(db, old.copyId);
  } catch (error) {
    await removeBlocks(db, copyId).catch(() => undefined);
    throw error;
  } finally { db.close(); }
}

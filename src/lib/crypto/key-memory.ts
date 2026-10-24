// Future client encryption code can register mutable key buffers here.
// This only wipes buffers held by this module; JS copies and browser memory
// outside our control cannot be guaranteed erased.
const buffers = new Set<Uint8Array>();
let vaultRootKey: Uint8Array | null = null;
let activeVaultId: string | null = null;
let generation = 0;

export function registerVaultKeyBuffer(buffer: Uint8Array): () => void {
  buffers.add(buffer);
  return () => buffers.delete(buffer);
}

export function clearVaultKeyMaterial(): void {
  for (const buffer of buffers) buffer.fill(0);
  buffers.clear();
  vaultRootKey = null;
  activeVaultId = null;
  generation += 1;
  if (typeof window !== "undefined") window.dispatchEvent(new Event("vaultx:key-clear"));
}

// A copied, mutable buffer is kept only in this browser module. CryptoKey
// copies inside Web Crypto or the browser cannot be guaranteed erased.
export function installVaultRootKey(source: Uint8Array, vaultId: string): void {
  if (source.length !== 32 || !/^[A-Za-z0-9_-]{22}$/.test(vaultId)) throw new Error("Invalid vault key");
  clearVaultKeyMaterial();
  vaultRootKey = source.slice();
  activeVaultId = vaultId;
  buffers.add(vaultRootKey);
  if (typeof window !== "undefined") window.dispatchEvent(new Event("vaultx:key-ready"));
}

export function hasVaultRootKey(): boolean {
  return vaultRootKey !== null;
}

export function assertVaultKeyActive(expectedGeneration: number, expectedVaultId: string): void {
  if (!vaultRootKey || generation !== expectedGeneration || activeVaultId !== expectedVaultId) {
    throw new Error("Vault key is locked");
  }
}

export function leaseVaultRootKey(): {
  key: Uint8Array;
  vaultId: string;
  generation: number;
  release: () => void;
} {
  if (!vaultRootKey || !activeVaultId) throw new Error("Vault key is locked");
  const key = vaultRootKey.slice();
  const vaultId = activeVaultId;
  const leasedGeneration = generation;
  buffers.add(key);
  return {
    key, vaultId, generation: leasedGeneration,
    release: () => { key.fill(0); buffers.delete(key); },
  };
}

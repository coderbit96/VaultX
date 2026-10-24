import { VAULT_KDF } from "./vault-key-schema";

// Test/worker entry point. UI invokes this inside a disposable Web Worker.
export async function deriveVaultPasswordKey(passwordBytes: Uint8Array, salt: Uint8Array): Promise<Uint8Array> {
  if (salt.length !== 16 || passwordBytes.length < 16 || passwordBytes.length > 4096) {
    throw new Error("Invalid vault password input");
  }
  const { argon2id } = await import("hash-wasm");
  const derived = await argon2id({
    password: passwordBytes,
    salt,
    memorySize: VAULT_KDF.memoryKiB,
    iterations: VAULT_KDF.iterations,
    parallelism: VAULT_KDF.parallelism,
    hashLength: VAULT_KDF.outputBytes,
    outputType: "binary",
  });
  if (!(derived instanceof Uint8Array) || derived.length !== 32) throw new Error("Vault KDF failed");
  return derived;
}

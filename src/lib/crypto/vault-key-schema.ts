import "./zod-csp";
import { z } from "zod";

const encoded = (length: number) => z.string().length(length).regex(/^[A-Za-z0-9_-]+$/).refine((value) => {
  try {
    const standard = value.replace(/-/g, "+").replace(/_/g, "/");
    const bytes = atob(standard + "=".repeat((4 - value.length % 4) % 4));
    return btoa(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "") === value;
  } catch { return false; }
});

export const VAULT_KDF = {
  algorithm: "argon2id",
  version: 19,
  memoryKiB: 65_536,
  iterations: 3,
  parallelism: 1,
  outputBytes: 32,
} as const;

export const vaultKeyEnvelopeSchema = z.strictObject({
  version: z.literal(1),
  vaultId: encoded(22),
  revision: z.number().int().min(1).max(2_147_483_647),
  password: z.strictObject({
    kdf: z.strictObject({
      algorithm: z.literal(VAULT_KDF.algorithm),
      version: z.literal(VAULT_KDF.version),
      memoryKiB: z.literal(VAULT_KDF.memoryKiB),
      iterations: z.literal(VAULT_KDF.iterations),
      parallelism: z.literal(VAULT_KDF.parallelism),
      outputBytes: z.literal(VAULT_KDF.outputBytes),
    }),
    salt: encoded(22),
    nonce: encoded(16),
    ciphertext: encoded(64),
  }),
  recovery: z.strictObject({
    algorithm: z.literal("HKDF-SHA-256/AES-256-GCM"),
    salt: encoded(43),
    nonce: encoded(16),
    ciphertext: encoded(64),
  }),
});

export type VaultKeyEnvelope = z.infer<typeof vaultKeyEnvelopeSchema>;

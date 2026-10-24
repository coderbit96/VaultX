import "./zod-csp";
import { z } from "zod";

// Only ciphertext is stored. The envelope is bound cryptographically to its
// stable folder ID and vault ID by the browser-side implementation.
export const encryptedNameSchema = z.strictObject({
  version: z.literal(1),
  vaultId: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
  salt: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  ciphertext: z.string().min(23).max(662).regex(/^[A-Za-z0-9_-]+$/),
  nonce: z.string().regex(/^[A-Za-z0-9_-]{16}$/),
  algorithm: z.literal("AES-256-GCM"),
});

export type EncryptedName = z.infer<typeof encryptedNameSchema>;
export type EncryptedFolderName = EncryptedName;

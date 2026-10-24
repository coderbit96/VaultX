import { deriveVaultPasswordKey } from "./argon2-browser";

self.onmessage = async (event: MessageEvent<{ password: Uint8Array; salt: Uint8Array }>) => {
  const { password, salt } = event.data;
  try {
    const key = await deriveVaultPasswordKey(password, salt);
    self.postMessage({ ok: true, key }, { transfer: [key.buffer] });
  } catch {
    self.postMessage({ ok: false });
  } finally {
    password.fill(0);
    salt.fill(0);
  }
};

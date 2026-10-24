export function derivePasswordInWorker(password: Uint8Array, salt: Uint8Array): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./argon2-worker.ts", import.meta.url), { type: "module" });
    const timeout = window.setTimeout(() => finish(new Error("Vault key derivation timed out")), 120_000);
    let finished = false;
    function finish(value: Uint8Array | Error) {
      if (finished) return;
      finished = true;
      window.clearTimeout(timeout);
      window.removeEventListener("vaultx:key-clear", cancel);
      worker.terminate();
      if (value instanceof Error) reject(value);
      else resolve(value);
    }
    const cancel = () => finish(new Error("Vault locked"));
    window.addEventListener("vaultx:key-clear", cancel);
    worker.onmessage = (event: MessageEvent<{ ok: boolean; key?: Uint8Array }>) => {
      const key = event.data.key;
      finish(event.data.ok && key instanceof Uint8Array && key.length === 32 ? key : new Error("Vault key derivation failed"));
    };
    worker.onerror = () => finish(new Error("Vault key derivation failed"));
    const passwordCopy = password.slice();
    worker.postMessage({ password: passwordCopy, salt: salt.slice() }, [passwordCopy.buffer]);
  });
}

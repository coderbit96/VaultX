import { clearVaultKeyMaterial, hasVaultRootKey, installVaultRootKey } from "./lib/crypto/key-memory";
import { unlockVaultWithPassphrase } from "./lib/crypto/vault-keys";
import { decryptFileName } from "./lib/crypto/file-names";
import { openEncryptedContainer } from "./lib/crypto/file-container";
import { downloadName } from "./lib/files/decrypt-client";
import { clearOfflineCopies, getOfflineEnvelope, listOfflineCopies, offlineCiphertextSource, openOfflineDetails, removeOfflineCopy, type OfflineCopy, type OfflineDetails } from "./lib/offline/copies";
import { onFileDeleting } from "./lib/files/deletion-events";

const form = document.querySelector<HTMLFormElement>("#unlock-form")!;
const password = document.querySelector<HTMLInputElement>("#vault-passphrase")!;
const list = document.querySelector<HTMLUListElement>("#copy-list")!;
const message = document.querySelector<HTMLElement>("#message")!;
const controls = document.querySelector<HTMLElement>("#copy-controls")!;
let idle: number | undefined;
let activeDownload: AbortController | null = null;
let unlockAttempt = 0;

function status(value: string): void { message.textContent = value; }
function lock(): void {
  unlockAttempt += 1;
  activeDownload?.abort(); activeDownload = null;
  clearVaultKeyMaterial();
  password.value = ""; list.replaceChildren();
  controls.hidden = true; form.hidden = false;
  window.clearTimeout(idle);
  status("Locked. Enter your separate vault passphrase to open selected copies.");
}
function activity(): void {
  if (hasVaultRootKey()) { window.clearTimeout(idle); idle = window.setTimeout(lock, 5 * 60_000); }
}
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") lock(); });
window.addEventListener("pagehide", lock);
window.addEventListener("vaultx:offline-clear", lock);
const clearChannel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel("vaultx-offline-clear");
if (clearChannel) clearChannel.onmessage = () => lock();
onFileDeleting((id) => {
  activeDownload?.abort();
  void (id === "*" ? clearOfflineCopies() : removeOfflineCopy(id)).then(() => {
    if (hasVaultRootKey()) void render();
  }).catch(() => status("Could not remove a deleted file's local copy. Clear offline copies manually."));
});
window.addEventListener("pointerdown", activity);
window.addEventListener("keydown", activity);

async function derive(passwordBytes: Uint8Array, salt: Uint8Array): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const worker = new Worker("/offline-kdf.js");
    const timer = window.setTimeout(() => finish(new Error("Key derivation timed out")), 120_000);
    function finish(result: Uint8Array | Error) {
      worker.terminate(); window.clearTimeout(timer);
      if (result instanceof Error) reject(result); else resolve(result);
    }
    worker.onmessage = (event: MessageEvent<{ ok: boolean; key?: Uint8Array }>) => {
      finish(event.data.ok && event.data.key instanceof Uint8Array ? event.data.key : new Error("Key derivation failed"));
    };
    worker.onerror = () => finish(new Error("Key derivation failed"));
    const copy = passwordBytes.slice();
    worker.postMessage({ password: copy, salt: salt.slice() }, [copy.buffer]);
  });
}

async function download(copy: OfflineCopy, name: string, details: OfflineDetails): Promise<void> {
  if (!hasVaultRootKey() || activeDownload) return;
  const controller = new AbortController(); activeDownload = controller;
  const suggested = downloadName(name, details.extension);
  // Picker must be called before awaiting another asynchronous operation.
  const picker = (window as Window & { showSaveFilePicker?: (options: { suggestedName: string }) => Promise<{ createWritable(): Promise<FileSystemWritableFileStream> }> }).showSaveFilePicker;
  let destination: FileSystemWritableFileStream | null = null;
  const parts: BlobPart[] = [];
  let opened: Awaited<ReturnType<typeof openEncryptedContainer>> | undefined;
  try {
    const handle = picker ? await picker.call(window, { suggestedName: suggested }) : null;
    destination = handle ? await handle.createWritable() : null;
    opened = await openEncryptedContainer(await offlineCiphertextSource(copy, details.storedSizeBytes), details.encryptionManifest, controller.signal);
    if (opened.metadata.extension.toLowerCase() !== details.extension.toLowerCase() || opened.metadata.mimeType.toLowerCase() !== details.mimeType.toLowerCase()) throw new Error("Stored format mismatch");
    if (!destination && Number(opened.plaintextLength) > 32_000_000) throw new Error("This browser cannot save a large offline file without buffering it. Reconnect and use a supported desktop browser.");
    for await (const chunk of opened.chunks()) {
      if (controller.signal.aborted || !hasVaultRootKey()) throw new Error("Vault locked");
      if (destination) await destination.write(chunk as Uint8Array<ArrayBuffer>);
      else parts.push(chunk.slice().buffer);
      chunk.fill(0);
    }
    if (controller.signal.aborted || !hasVaultRootKey()) throw new Error("Vault locked");
    if (destination) await destination.close();
    else {
      const url = URL.createObjectURL(new Blob(parts, { type: "application/octet-stream" }));
      const anchor = document.createElement("a"); anchor.href = url; anchor.download = suggested;
      document.body.append(anchor); anchor.click(); anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
    }
    status("Offline download complete.");
  } catch (error) {
    await destination?.abort().catch(() => undefined);
    for (const part of parts) if (part instanceof ArrayBuffer) new Uint8Array(part).fill(0);
    throw error;
  } finally { opened?.close(); activeDownload = null; }
}

async function render(): Promise<void> {
  list.replaceChildren();
  const copies = await listOfflineCopies();
  if (copies.length === 0) { status("No selected offline copies remain. Reconnect and select a file in VaultX."); return; }
  for (const copy of copies) {
    try {
      const details = await openOfflineDetails(copy);
      const name = await decryptFileName(copy.id, details.nameEncrypted);
      const item = document.createElement("li");
      const label = document.createElement("span"); label.textContent = `${name} · ${(details.storedSizeBytes / 1_000_000).toFixed(2)} MB encrypted`;
      const button = document.createElement("button"); button.type = "button"; button.textContent = "Download decrypted copy";
      button.addEventListener("click", () => { status("Checking and decrypting selected copy…"); void download(copy, name, details).catch(() => status("Offline copy could not be authenticated or saved. It may be incomplete or browser storage may have been cleared.")); });
      const remove = document.createElement("button"); remove.type = "button"; remove.className = "secondary"; remove.textContent = "Remove local copy";
      remove.addEventListener("click", () => { activeDownload?.abort(); void removeOfflineCopy(copy.id).then(() => render()).catch(() => status("Could not remove the local copy.")); });
      item.append(label, button, remove); list.append(item);
    } catch { status("An offline copy could not be opened. It may belong to an older vault key."); }
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const attempt = ++unlockAttempt;
  const passphrase = password.value; password.value = "";
  status("Unlocking local encrypted copies…");
  void (async () => {
    const envelope = await getOfflineEnvelope();
    if (!envelope) throw new Error("No local key envelope");
    const root = await unlockVaultWithPassphrase(envelope, passphrase, derive);
    try {
      if (attempt !== unlockAttempt || document.visibilityState !== "visible") return;
      installVaultRootKey(root, envelope.vaultId);
    } finally { root.fill(0); }
    form.hidden = true; controls.hidden = false;
    activity(); await render();
  })().catch(() => { lock(); status("Could not unlock local copies. Check your vault passphrase, or reconnect to VaultX."); });
});
document.querySelector<HTMLButtonElement>("#lock-button")!.addEventListener("click", lock);
document.querySelector<HTMLButtonElement>("#clear-button")!.addEventListener("click", () => {
  if (!confirm("Remove every encrypted offline copy from this browser? Cloud files will remain online.")) return;
  lock(); void clearOfflineCopies().then(() => status("Offline copies removed from this browser.")).catch(() => status("Could not clear copies. Close other VaultX tabs and retry."));
});
void listOfflineCopies().then((copies) => { if (!copies.length) status("No selected copies on this device. Reconnect to VaultX to save one."); }).catch(() => status("Offline storage is unavailable or was cleared by your browser."));

"use client";

const eventName = "vaultx:file-deleting";
const channelName = "vaultx-file-deletions";

export function announceFileDeleting(fileId: string) {
  window.dispatchEvent(new CustomEvent<string>(eventName, { detail: fileId }));
  if ("BroadcastChannel" in window) {
    const channel = new BroadcastChannel(channelName);
    channel.postMessage(fileId);
    channel.close();
  }
}

// A folder job can affect many open file views. Clear every VaultX-managed
// preview in this browser and other tabs when its subtree is fenced.
export function announceFolderDeleting() { announceFileDeleting("*"); }

export function onFileDeleting(listener: (fileId: string) => void): () => void {
  const local = (event: Event) => listener((event as CustomEvent<string>).detail);
  window.addEventListener(eventName, local);
  const channel = "BroadcastChannel" in window ? new BroadcastChannel(channelName) : null;
  if (channel) channel.onmessage = (event: MessageEvent<unknown>) => {
    if (typeof event.data === "string" && (event.data === "*" || /^[a-f0-9]{24}$/.test(event.data))) listener(event.data);
  };
  return () => { window.removeEventListener(eventName, local); channel?.close(); };
}

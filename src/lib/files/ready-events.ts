"use client";

const eventName = "vaultx:file-ready";
const channelName = "vaultx-file-ready";

export function announceFileReady(fileId: string): void {
  if (!/^[a-f0-9]{24}$/.test(fileId)) return;
  window.dispatchEvent(new CustomEvent<string>(eventName, { detail: fileId }));
  if ("BroadcastChannel" in window) {
    const channel = new BroadcastChannel(channelName);
    channel.postMessage(fileId);
    channel.close();
  }
}

export function onFileReady(listener: () => void): () => void {
  const local = (event: Event) => {
    if (/^[a-f0-9]{24}$/.test((event as CustomEvent<string>).detail)) listener();
  };
  window.addEventListener(eventName, local);
  const channel = "BroadcastChannel" in window ? new BroadcastChannel(channelName) : null;
  if (channel) channel.onmessage = (event: MessageEvent<unknown>) => {
    if (typeof event.data === "string" && /^[a-f0-9]{24}$/.test(event.data)) listener();
  };
  return () => { window.removeEventListener(eventName, local); channel?.close(); };
}

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import manifest from "../src/app/manifest";

test("manifest starts at the server lock route and icons have real advertised dimensions", async () => {
  const data = manifest();
  assert.equal(data.start_url, "/");
  assert.equal(data.display, "standalone");
  assert.equal(data.theme_color, "#0b0d0e");
  for (const icon of data.icons ?? []) {
    const path = join(process.cwd(), "public", icon.src!.slice(1));
    const png = await readFile(path);
    assert.equal(png.subarray(1, 4).toString(), "PNG");
    const size = Number(icon.sizes!.split("x")[0]);
    assert.equal(png.readUInt32BE(16), size);
    assert.equal(png.readUInt32BE(20), size);
  }
  assert.equal(data.icons?.some((icon) => icon.purpose === "maskable"), true);
  const apple = await readFile(join(process.cwd(), "public", "icons", "apple-touch-icon.png"));
  assert.equal(apple.readUInt32BE(16), 180);
  assert.equal(apple.readUInt32BE(20), 180);
});

test("service worker caches only fixed public shell files and never stores private responses", async () => {
  const source = await readFile(join(process.cwd(), "public", "sw.js"), "utf8");
  const offlineHtml = await readFile(join(process.cwd(), "public", "offline.html"), "utf8");
  assert.doesNotMatch(offlineHtml, /filename|password|token|publicId/i);
  const listeners = new Map<string, (event: Record<string, unknown>) => void>();
  const entries = new Map<string, Response>();
  const pathOf = (request: string | { url: string }) => typeof request === "string"
    ? new URL(request, "https://vaultx.example").pathname : new URL(request.url).pathname;
  const cache = { async addAll(paths: string[]) { for (const path of paths) {
    entries.set(path, new Response(path === "/offline.html" ? offlineHtml : `public:${path}`));
  } }, async match(request: string | { url: string }) { return entries.get(pathOf(request)); } };
  const caches = { async open() { return cache; }, async match(request: string | { url: string }) {
    return cache.match(request); }, async keys() { return ["vaultx-public-shell-v1"]; }, async delete() { return true; } };
  let networkCalls = 0;
  let skipWaiting = false;
  const network = async () => { networkCalls++; throw new Error("offline"); };
  const self = { location: { origin: "https://vaultx.example" }, clients: { async claim() {} },
    addEventListener(name: string, handler: (event: Record<string, unknown>) => void) { listeners.set(name, handler); },
    skipWaiting() { skipWaiting = true; } };
  runInNewContext(source, { self, caches, fetch: network, URL, Response, Set });
  let install: Promise<unknown> | undefined;
  listeners.get("install")!({ waitUntil(value: Promise<unknown>) { install = value; } });
  await install;
  assert.deepEqual([...entries.keys()].sort(), ["/offline.html", "/offline-vault.html", "/offline-vault.js", "/offline-kdf.js", "/icons/icon-192.png", "/icons/icon-512.png",
    "/icons/icon-maskable-512.png", "/icons/apple-touch-icon.png"].sort());
  const dispatch = (url: string, mode: string, method = "GET") => {
    let response: Promise<Response> | undefined;
    listeners.get("fetch")!({ request: { url: `https://vaultx.example${url}`, mode, method },
      respondWith(value: Promise<Response>) { response = value; } });
    return response;
  };
  for (const path of ["/api/auth/verify", "/api/files/abc/download", "/api/uploads/abc/ciphertext",
    "/_next/static/chunks/app.js", "/vault/file.png"]) {
    assert.equal(dispatch(path, "cors"), undefined);
  }
  assert.equal(networkCalls, 0);
  const fallback = await dispatch("/vault/files", "navigate");
  assert.match(await fallback!.text(), /Connection needed/);
  assert.equal(networkCalls, 1);
  assert.equal(entries.size, 8);
  listeners.get("message")!({ data: "SKIP_WAITING" });
  assert.equal(skipWaiting, true);
});

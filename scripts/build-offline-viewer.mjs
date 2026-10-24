import { build } from "esbuild";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const alias = { "@": resolve("src") };
await build({ entryPoints: ["src/offline-viewer.ts"], outfile: "public/offline-vault.js", bundle: true,
  platform: "browser", format: "iife", target: "es2022", minify: true, alias, logLevel: "warning" });
await build({ entryPoints: ["src/lib/crypto/argon2-worker.ts"], outfile: "public/offline-kdf.js", bundle: true,
  platform: "browser", format: "iife", target: "es2022", minify: true, alias, logLevel: "warning" });
const [viewer, worker, template] = await Promise.all([
  readFile("public/offline-vault.js"), readFile("public/offline-kdf.js"), readFile("scripts/sw-template.js", "utf8"),
]);
const version = createHash("sha256").update(viewer).update(worker).digest("hex").slice(0, 16);
await writeFile("public/sw.js", template.replace("__VAULTX_SHELL_VERSION__", version));

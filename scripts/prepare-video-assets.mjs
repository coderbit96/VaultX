import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

// Serve pinned encoder code from this installation. Never fetch executable
// transcoder code from a third-party CDN at runtime.
const root = process.cwd();
const target = join(root, "public", "ffmpeg");
const files = [
  ["@ffmpeg/ffmpeg", "worker.js"],
  ["@ffmpeg/ffmpeg", "const.js"],
  ["@ffmpeg/ffmpeg", "errors.js"],
  ["@ffmpeg/core", "ffmpeg-core.js"],
  ["@ffmpeg/core", "ffmpeg-core.wasm"],
];
await mkdir(target, { recursive: true });
for (const [pkg, name] of files) {
  const source = pkg === "@ffmpeg/core"
    ? join(root, "node_modules", "@ffmpeg", "core", "dist", "esm", name)
    : join(root, "node_modules", "@ffmpeg", "ffmpeg", "dist", "esm", name);
  await copyFile(source, join(target, name));
}
console.log("Local video encoder assets ready.");

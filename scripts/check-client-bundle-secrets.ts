import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { loadEnvConfig } from "@next/env";

// Run after production build. Never print a credential or the matching bytes.
async function filesUnder(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => {
    const location = join(path, entry.name);
    return entry.isDirectory() ? filesUnder(location) : Promise.resolve([location]);
  }));
  return nested.flat();
}

async function main() {
  loadEnvConfig(process.cwd(), false);
  const keys = ["MONGODB_URI", "CLOUDINARY_API_KEY", "CLOUDINARY_API_SECRET", "AUTH_SECRET", "AUTH_OWNER_EMAIL"] as const;
  const configured = keys.map((key) => ({ key, value: process.env[key] ?? "" }))
    .filter(({ value }) => value.length >= 8 && !/[<>]/.test(value));
  const uri = process.env.MONGODB_URI ?? "";
  const credentials = /^mongodb(?:\+srv)?:\/\/([^@]+)@/.exec(uri)?.[1];
  const password = credentials?.slice(credentials.indexOf(":") + 1);
  if (password && password.length >= 8) {
    configured.push({ key: "MONGODB_URI", value: decodeURIComponent(password) });
  }
  const publicFiles = (await filesUnder(join(process.cwd(), ".next", "static"))).filter((name) => /\.(?:js|css|html)$/.test(name));
  publicFiles.push(...["offline-vault.js", "offline-kdf.js", "sw.js"].map((name) => join(process.cwd(), "public", name)));
  let checked = 0;
  for (const path of publicFiles) {
    const data = await readFile(path);
    checked++;
    for (const { key, value } of configured) {
      if (data.includes(Buffer.from(value))) throw new Error(`A configured ${key} value reached a public bundle. Remove it before deployment.`);
    }
  }
  console.log(`Public bundle secret-value scan passed (${checked} files, ${configured.length} configured values).`);
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error && /^A configured [A-Z_]+ value reached/.test(error.message)
    ? error.message : "Public bundle scan could not complete; build first and retry.");
  process.exitCode = 1;
});

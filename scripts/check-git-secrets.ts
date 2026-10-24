import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { loadEnvConfig } from "@next/env";

// Compare configured values with every file eligible for a commit and the
// existing history. Report only paths/status, never the matching bytes.
loadEnvConfig(process.cwd());

const forbiddenPaths = /(^|\/)(?:\.env(?:\.[^/]*)?|reports\/.*)$/i;
const paths = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"])
  .toString("utf8").split("\0").filter(Boolean);
const configured = [
  "MONGODB_URI", "CLOUDINARY_API_KEY", "CLOUDINARY_API_SECRET",
  "AUTH_SECRET", "AUTH_OWNER_EMAIL",
].map((name) => process.env[name]).filter((value): value is string => !!value && value.length >= 8);
const credentials = /^mongodb(?:\+srv)?:\/\/([^@]+)@/.exec(process.env.MONGODB_URI ?? "")?.[1];
const password = credentials?.slice(credentials.indexOf(":") + 1);
if (password && password.length >= 8) {
  configured.push(password);
  try { configured.push(decodeURIComponent(password)); } catch { /* already encoded */ }
}

let failed = false;
let checked = 0;
for (const path of paths) {
  const normalized = path.replaceAll("\\", "/");
  if (!existsSync(path) || !statSync(path).isFile()) continue;
  if (forbiddenPaths.test(normalized) && !normalized.endsWith(".env.example")) {
    console.error(`BLOCKED: private environment/report file is eligible for Git: ${normalized}`);
    failed = true;
    continue;
  }
  checked++;
  const bytes = readFileSync(path);
  if (configured.some((value) => bytes.includes(Buffer.from(value)))) {
    console.error(`BLOCKED: configured secret-like value found in Git-eligible file: ${normalized}`);
    failed = true;
  }
}

const history = execFileSync("git", ["log", "-p", "--all", "--no-color"], {
  maxBuffer: 64 * 1024 * 1024,
});
if (configured.some((value) => history.includes(Buffer.from(value)))) {
  console.error("BLOCKED: a configured secret-like value appears in Git history. Rotate it and review the history before publishing.");
  failed = true;
}

if (!failed) console.log(`Git secret-value check passed (${checked} eligible files and existing history; ${configured.length} configured values).`);
else process.exitCode = 1;

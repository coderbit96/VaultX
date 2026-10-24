import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";
import { onRequestError } from "../src/instrumentation";

test("Vercel build stops before advertising unsupported ciphertext transfers", () => {
  const result = spawnSync(process.execPath, [resolve("scripts/check-host-compatibility.mjs")], {
    cwd: process.cwd(), env: { ...process.env, VERCEL: "1", CLOUDINARY_API_SECRET: "TEST_ONLY_SECRET" },
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /BLOCKED: Vercel Functions/);
  assert.doesNotMatch(result.stderr, /TEST_ONLY_SECRET/);
});

test("Node server build passes the host gate without reading secrets", () => {
  const env = { ...process.env };
  delete env.VERCEL;
  const result = spawnSync(process.execPath, [resolve("scripts/check-host-compatibility.mjs")], {
    cwd: process.cwd(), env, encoding: "utf8",
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Node server build permitted/);
});

test("unhandled error monitoring emits only a fixed redacted signal", () => {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...parts: unknown[]) => { lines.push(parts.join(" ")); };
  try {
    onRequestError(new Error("TEST_ONLY_PRIVATE_FILENAME_AND_TOKEN"), {
      path: "/vault/files/TEST_ONLY_PRIVATE_FILENAME_AND_TOKEN", method: "GET",
      headers: { cookie: "TEST_ONLY_PRIVATE_FILENAME_AND_TOKEN" },
    }, { routeType: "route", routePath: "/api/files/[id]", routerKind: "App Router",
      renderSource: "server-rendering", revalidateReason: undefined });
  } finally { console.error = original; }
  assert.deepEqual(lines, ["vaultx_unhandled_request_error area=route"]);
});

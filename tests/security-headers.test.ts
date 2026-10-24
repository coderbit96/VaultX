import assert from "node:assert/strict";
import test from "node:test";
import { documentContentSecurityPolicy } from "../src/lib/auth/security-headers";

const nonce = Buffer.alloc(16, 7).toString("base64");

test("production document policy uses a request nonce and restricts active content", () => {
  const policy = documentContentSecurityPolicy(nonce, false);
  for (const directive of [
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' 'wasm-unsafe-eval'`,
    "connect-src 'self'", "object-src 'none'", "base-uri 'none'",
    "form-action 'self'", "frame-ancestors 'none'", "upgrade-insecure-requests",
  ]) assert.ok(policy.includes(directive));
  assert.equal(policy.includes("'unsafe-eval'"), false);
  assert.equal(policy.includes("https://res.cloudinary.com"), false);
  assert.equal(policy.includes("script-src 'self' 'unsafe-inline'"), false);
  assert.throws(() => documentContentSecurityPolicy("injected; script-src *", false));
});

test("development policy permits debugging eval without weakening production", () => {
  const policy = documentContentSecurityPolicy(nonce, true);
  assert.ok(policy.includes("'unsafe-eval'"));
  assert.equal(policy.includes("upgrade-insecure-requests"), false);
});

import assert from "node:assert/strict";
import test from "node:test";
import { ObjectId } from "mongodb";
import { deviceDigest, pinCookieName, pinCookieOptions, pinPattern } from "../src/lib/auth/pin";
import { challengeCookieName, challengeCookieOptions, webauthnSite } from "../src/lib/auth/webauthn";
import { deviceCredentialSchema, pinCredentialSchema } from "../src/lib/database/models";
import { modelIndexes } from "../src/lib/database/model-indexes";
import { isEnabledPrivateApiMethod, isEnabledPrivateApiPath } from "../src/lib/auth/api-policy";

test("PIN is exactly six digits, device token stays HttpOnly and hashed", () => {
  assert.equal(pinPattern.test("123456"), true);
  for (const value of ["12345", "1234567", "12345a", "١٢٣٤٥٦"]) assert.equal(pinPattern.test(value), false);
  const token = "A".repeat(43);
  assert.match(deviceDigest(token)!, /^[a-f0-9]{64}$/);
  assert.notEqual(deviceDigest(token), token);
  assert.equal(deviceDigest("invalid"), null);
  assert.equal(pinCookieName(true), "__Host-vaultx_pin_device");
  assert.deepEqual(pinCookieOptions(true, 60), { httpOnly: true, secure: true, sameSite: "strict", path: "/", maxAge: 60 });
  assert.equal(challengeCookieName(true), "__Host-vaultx_webauthn");
  assert.deepEqual(challengeCookieOptions(true, 300), { httpOnly: true, secure: true, sameSite: "strict", path: "/", maxAge: 300 });
});

test("device schemas store only salted PIN verifier and public passkey data", () => {
  const ownerId = new ObjectId();
  const pinRecord = { _id: new ObjectId(), ownerId, deviceDigest: "a".repeat(64),
    verifier: "$argon2id$v=19$m=65536,p=1,t=3$synthetic$synthetic", failedAttempts: 0,
    createdAt: new Date(), expiresAt: new Date(Date.now() + 60_000) };
  assert.equal(pinCredentialSchema.safeParse(pinRecord).success, true);
  assert.equal(pinCredentialSchema.safeParse({ ...pinRecord, pin: "123456" }).success, false);
  assert.equal(pinCredentialSchema.safeParse({ ...pinRecord, failedAttempts: 6 }).success, false);
  const passkeyRecord = { _id: new ObjectId(), ownerId, credentialId: "A".repeat(32),
    publicKey: "B".repeat(64), signCount: 0, rpId: "localhost", transports: ["internal"], createdAt: new Date() };
  assert.equal(deviceCredentialSchema.safeParse(passkeyRecord).success, true);
  assert.equal(deviceCredentialSchema.safeParse({ ...passkeyRecord, privateKey: "forbidden" }).success, false);
  assert.equal(modelIndexes.pinCredentials.some((index) => index.unique && !((index.key) instanceof Map) && index.key?.deviceDigest === 1), true);
  assert.equal(modelIndexes.webauthnChallenges.some((index) => index.expireAfterSeconds === 0), true);
});

test("private device methods stay default denied except explicit policy", () => {
  for (const route of ["/api/settings/pin", "/api/settings/passkeys", "/api/settings/passkeys/options", "/api/settings/passkeys/verify"]) {
    assert.equal(isEnabledPrivateApiPath(route), true);
  }
  assert.equal(isEnabledPrivateApiMethod("/api/settings/pin", "DELETE"), true);
  assert.equal(isEnabledPrivateApiMethod("/api/settings/passkeys/options", "GET"), false);
  assert.equal(isEnabledPrivateApiPath("/api/settings/passkeys/unknown"), false);
  assert.equal(isEnabledPrivateApiPath("/api/settings/pin/unknown"), false);
});

test("WebAuthn RP origin must match the configured site", () => {
  const priorOrigin = process.env.WEBAUTHN_ORIGIN;
  const priorRp = process.env.WEBAUTHN_RP_ID;
  try {
    process.env.WEBAUTHN_ORIGIN = "https://vault.example.test";
    process.env.WEBAUTHN_RP_ID = "vault.example.test";
    assert.deepEqual(webauthnSite(new Request("https://vault.example.test/api/auth/passkey/options")),
      { origin: "https://vault.example.test", rpID: "vault.example.test" });
    assert.equal(webauthnSite(new Request("https://attacker.example.test/api/auth/passkey/options")), null);
    process.env.WEBAUTHN_RP_ID = "attacker.example.test";
    assert.equal(webauthnSite(new Request("https://vault.example.test/api/auth/passkey/options")), null);
    process.env.WEBAUTHN_ORIGIN = "http://vault.example.test";
    process.env.WEBAUTHN_RP_ID = "vault.example.test";
    assert.equal(webauthnSite(new Request("http://vault.example.test/api/auth/passkey/options")), null);
  } finally {
    if (priorOrigin === undefined) delete process.env.WEBAUTHN_ORIGIN; else process.env.WEBAUTHN_ORIGIN = priorOrigin;
    if (priorRp === undefined) delete process.env.WEBAUTHN_RP_ID; else process.env.WEBAUTHN_RP_ID = priorRp;
  }
});

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { NextRequest } from "next/server";
import { encode, getToken } from "next-auth/jwt";
import { isBoundAuthToken } from "../src/lib/auth/auth-binding";
import { createSessionToken, digestSessionToken } from "../src/lib/auth/session-core";

test("Auth.js cookie is encrypted, scoped to the exact owner and Mongo session, and expires", async () => {
  const mongoToken = createSessionToken();
  const secret = randomBytes(32).toString("base64url");
  const ownerId = "000000000000000000000001";
  const jwt = await encode({ token: { ownerId, sessionDigest: digestSessionToken(mongoToken) }, secret, maxAge: 3600 });
  assert.equal(jwt.includes(mongoToken), false);
  assert.equal(jwt.includes(digestSessionToken(mongoToken)), false);
  const request = new NextRequest("http://localhost/", { headers: { cookie: `vaultx_auth=${jwt}` } });
  const decoded = await getToken({ req: request, secret, cookieName: "vaultx_auth", secureCookie: false });
  assert.equal(isBoundAuthToken(decoded, mongoToken, ownerId), true);
  assert.equal(isBoundAuthToken(decoded, createSessionToken(), ownerId), false);
  assert.equal(isBoundAuthToken(decoded, mongoToken, "000000000000000000000002"), false);
  assert.equal(isBoundAuthToken({ ownerId, sessionDigest: "not-hex" }, mongoToken, ownerId), false);
  assert.equal(await getToken({ req: request, secret: randomBytes(32).toString("base64url"), cookieName: "vaultx_auth" }), null);
  const expired = await encode({ token: { ownerId, sessionDigest: digestSessionToken(mongoToken) }, secret, maxAge: -60 });
  const expiredRequest = new NextRequest("http://localhost/", { headers: { cookie: `vaultx_auth=${expired}` } });
  assert.equal(await getToken({ req: expiredRequest, secret, cookieName: "vaultx_auth" }), null);
});

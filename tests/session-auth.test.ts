import assert from "node:assert/strict";
import test from "node:test";
import argon2 from "argon2";
import { ObjectId } from "mongodb";
import {
  authenticateSession, createSessionToken, digestSessionToken, idleExpiry,
  isSameOriginMutation, loginWithPassword, logoutSession,
  isDocumentOpening, lockSession,
  sessionCookieName, sessionCookieOptions, SESSION_ABSOLUTE_MS,
  type AuthStore,
} from "../src/lib/auth/session-core";
import { ownerHashOptions } from "../src/lib/auth/owner-bootstrap";
import type { Owner, Session } from "../src/lib/database/models";
import { privateAssetStatus } from "../src/lib/auth/private-asset";
import { clearVaultKeyMaterial, registerVaultKeyBuffer } from "../src/lib/crypto/key-memory";

const now = new Date("2026-10-14T12:00:00Z");
const privateTestPassword = "fictional-testing-passphrase-84";

async function fakeStore(withOwner = true, maxAttempts = 8) {
  const owner: Owner | null = withOwner ? {
    _id: new ObjectId(), singletonKey: "vaultx-owner", username: "owner",
    passwordHash: await argon2.hash(privateTestPassword, ownerHashOptions), initializedAt: now,
    settings: { autoLockMinutes: 15, requireLockOnOpen: true },
  } : null;
  const sessions = new Map<string, Session>();
  let attempts = 0;
  const store: AuthStore = {
    async reserveLoginAttempt() { return ++attempts <= maxAttempts; },
    async findOwner() { return owner; },
    async insertSession(session) { sessions.set(session.tokenDigest, session); },
    async revokeToken(digest) { sessions.delete(digest); },
    async lockToken(digest, at) {
      const session = sessions.get(digest);
      if (session && !session.lockedAt) sessions.set(digest, { ...session, lockedAt: at });
    },
    async touchSession(digest, ownerId, at, proposedIdleExpiry, idleCutoff) {
      const session = sessions.get(digest);
      if (!session || !session.ownerId.equals(ownerId) || session.expiresAt <= at || session.idleExpiresAt <= at || session.lastSeenAt <= idleCutoff || session.lockedAt) return null;
      const updated = { ...session, lastSeenAt: at, idleExpiresAt: new Date(Math.min(proposedIdleExpiry.getTime(), session.expiresAt.getTime())) };
      sessions.set(digest, updated);
      return updated;
    },
  };
  return { store, sessions, owner };
}

test("wrong password and missing owner give the same invalid response", async () => {
  const present = await fakeStore();
  const missing = await fakeStore(false);
  assert.deepEqual(await loginWithPassword(present.store, "wrong-password", undefined, now), { kind: "invalid" });
  assert.deepEqual(await loginWithPassword(missing.store, "wrong-password", undefined, now), { kind: "invalid" });
  assert.deepEqual(await loginWithPassword(present.store, { unexpected: true }, undefined, now), { kind: "invalid" });
  assert.equal(present.sessions.size, 0);
});

test("a correct password with a different configured identity never creates a session", async () => {
  const { store, sessions } = await fakeStore();
  assert.deepEqual(await loginWithPassword(store, privateTestPassword, undefined, now, "Other browser", false), { kind: "invalid" });
  assert.equal(sessions.size, 0);
});

test("tokens are random, stored only as digests, and previous session rotates", async () => {
  const { store, sessions } = await fakeStore();
  const first = await loginWithPassword(store, privateTestPassword, undefined, now);
  assert.equal(first.kind, "ok");
  if (first.kind !== "ok") return;
  assert.equal(first.token.length, 43);
  assert.equal(sessions.has(digestSessionToken(first.token)), true);
  assert.equal(JSON.stringify([...sessions.values()]).includes(first.token), false);
  const second = await loginWithPassword(store, privateTestPassword, first.token, now);
  assert.equal(second.kind, "ok");
  if (second.kind !== "ok") return;
  assert.notEqual(first.token, second.token);
  assert.equal(sessions.has(digestSessionToken(first.token)), false);
  assert.equal(await authenticateSession(store, first.token, now), null);
  assert.equal((await authenticateSession(store, second.token, now))?.equals((await store.findOwner())!._id), true);
});

test("idle and absolute expiration fail closed, while activity never extends absolute expiry", async () => {
  const { store, sessions } = await fakeStore();
  const result = await loginWithPassword(store, privateTestPassword, undefined, now);
  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") return;
  assert.equal(result.expiresAt.getTime() - now.getTime(), SESSION_ABSOLUTE_MS);
  const afterActivity = new Date(now.getTime() + 14 * 60_000);
  assert.ok(await authenticateSession(store, result.token, afterActivity));
  assert.equal(await authenticateSession(store, result.token, new Date(now.getTime() + 30 * 60_000)), null);
  const digest = digestSessionToken(result.token);
  const session = sessions.get(digest)!;
  sessions.set(digest, { ...session, lastSeenAt: new Date(result.expiresAt.getTime() - 1000), idleExpiresAt: result.expiresAt });
  assert.ok(await authenticateSession(store, result.token, new Date(result.expiresAt.getTime() - 1000)));
  assert.equal(sessions.get(digest)?.idleExpiresAt.getTime(), result.expiresAt.getTime());
  assert.equal(await authenticateSession(store, result.token, result.expiresAt), null);
  assert.equal(idleExpiry(now, 15, result.expiresAt).getTime(), now.getTime() + 15 * 60_000);
});

test("logout revokes current token and anonymous requests cannot authenticate", async () => {
  const { store } = await fakeStore();
  assert.equal(await authenticateSession(store, undefined, now), null);
  assert.equal(await authenticateSession(store, "malformed", now), null);
  const result = await loginWithPassword(store, privateTestPassword, undefined, now);
  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") return;
  await logoutSession(store, result.token);
  assert.equal(await authenticateSession(store, result.token, now), null);
});

test("login attempts are limited and credentials are never returned", async () => {
  const { store } = await fakeStore(true, 1);
  assert.deepEqual(await loginWithPassword(store, "wrong-password", undefined, now), { kind: "invalid" });
  assert.deepEqual(await loginWithPassword(store, privateTestPassword, undefined, now), { kind: "limited" });
});

test("cookie flags and origin checks protect browser requests", () => {
  assert.equal(sessionCookieName(true), "__Host-vaultx_session");
  assert.equal(sessionCookieName(false), "vaultx_session");
  assert.deepEqual(sessionCookieOptions(true, 3600), { httpOnly: true, secure: true, sameSite: "strict", path: "/", maxAge: 3600 });
  assert.equal(sessionCookieOptions(false, 3600).secure, false);
  const request = (origin?: string, site?: string) => new Request("http://localhost:3000/api/auth/login", {
    method: "POST", headers: { ...(origin ? { Origin: origin } : {}), ...(site ? { "Sec-Fetch-Site": site } : {}) },
  });
  assert.equal(isSameOriginMutation(request("http://localhost:3000", "same-origin")), true);
  assert.equal(isSameOriginMutation(request("https://attacker.example", "cross-site")), false);
  assert.equal(isSameOriginMutation(request()), false);
  assert.notEqual(createSessionToken(), createSessionToken());
});

test("lock denies session, guessed media access and download until password login", async () => {
  const { store, sessions } = await fakeStore();
  const first = await loginWithPassword(store, privateTestPassword, undefined, now);
  assert.equal(first.kind, "ok");
  if (first.kind !== "ok") return;
  assert.equal(await privateAssetStatus(store, first.token, now), 404);
  await lockSession(store, first.token, new Date(now.getTime() + 1000));
  assert.ok(sessions.get(digestSessionToken(first.token))?.lockedAt);
  assert.equal(await authenticateSession(store, first.token, new Date(now.getTime() + 2000)), null);
  assert.equal(await privateAssetStatus(store, first.token, now), 401);
  assert.equal(await privateAssetStatus(store, undefined, now), 401);
  const second = await loginWithPassword(store, privateTestPassword, first.token, new Date(now.getTime() + 3000));
  assert.equal(second.kind, "ok");
  if (second.kind !== "ok") return;
  assert.equal(await privateAssetStatus(store, first.token, now), 401);
  assert.equal(await privateAssetStatus(store, second.token, new Date(now.getTime() + 3000)), 404);
});

test("full document opening requires unlock and mutable key buffers are wiped", () => {
  assert.equal(isDocumentOpening(new Headers()), true);
  assert.equal(isDocumentOpening(new Headers({ "Sec-Fetch-Mode": "navigate" })), true);
  assert.equal(isDocumentOpening(new Headers({ "Sec-Fetch-Dest": "empty", RSC: "1" })), false);
  const key = new Uint8Array([1, 2, 3]);
  registerVaultKeyBuffer(key);
  clearVaultKeyMaterial();
  assert.deepEqual([...key], [0, 0, 0]);
});

import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { ObjectId, type Db } from "mongodb";
import { z } from "zod";
import { apiError, isEnabledPrivateApiMethod, isEnabledPrivateApiPath, isPrivateApiPath } from "../src/lib/auth/api-policy";
import { parseObjectId, readJsonRequest } from "../src/lib/auth/request-validation";
import { findOwnedActiveFolderId, findOwnedDeletionJob, findOwnedFile, findOwnedFolder, findOwnedReadyCloudAsset, findOwnedUploadJob } from "../src/lib/auth/owned-resources";

test("every private route is explicitly enabled and authorizes before handling data", async () => {
  const root = join(process.cwd(), "src", "app", "api");
  async function walk(path: string): Promise<string[]> {
    const entries = await readdir(path, { withFileTypes: true });
    const found = await Promise.all(entries.map((entry) => entry.isDirectory()
      ? walk(join(path, entry.name)) : Promise.resolve(entry.name === "route.ts" ? [join(path, entry.name)] : [])));
    return found.flat();
  }
  for (const prefix of ["vault", "files", "folders", "uploads", "deletions", "settings"]) {
    for (const route of await walk(join(root, prefix))) {
      const relative = route.slice(root.length).replaceAll("\\", "/").replace(/\/route\.ts$/, "");
      const pathname = `/api${relative}`.replace("[id]", "507f1f77bcf86cd799439011");
      assert.equal(isEnabledPrivateApiPath(pathname), true, `${pathname} is missing from the proxy allowlist`);
      const source = await readFile(route, "utf8");
      assert.match(source, /authorizeOwnerApi|privateCiphertextRoute/, `${pathname} has no server-side owner check`);
    }
  }
  for (const publicName of ["signup", "register", "share"]) {
    assert.equal((await readdir(root)).includes(publicName), false);
  }
  assert.match(await readFile(join(process.cwd(), "src", "app", "vault", "layout.tsx"), "utf8"), /requireOwner\(/);
});

test("private API prefixes default closed and only reviewed routes and methods are enabled", () => {
  for (const prefix of ["vault", "files", "folders", "uploads", "deletions", "settings"]) {
    assert.equal(isPrivateApiPath(`/api/${prefix}`), true);
    assert.equal(isPrivateApiPath(`/api/${prefix}/future/action`), true);
    assert.equal(isEnabledPrivateApiPath(`/api/${prefix}/future/action`), false);
  }
  assert.equal(isPrivateApiPath("/api/files-public"), false);
  assert.equal(isEnabledPrivateApiPath("/api/settings"), true);
  assert.equal(isEnabledPrivateApiMethod("/api/settings", "GET"), true);
  assert.equal(isEnabledPrivateApiMethod("/api/settings", "PATCH"), true);
  assert.equal(isEnabledPrivateApiMethod("/api/settings", "POST"), false);
  assert.equal(isEnabledPrivateApiPath("/api/files/invalid/access"), true);
  assert.equal(isEnabledPrivateApiPath("/api/files"), true);
  assert.equal(isEnabledPrivateApiMethod("/api/files", "GET"), true);
  assert.equal(isEnabledPrivateApiMethod("/api/files", "POST"), false);
  assert.equal(isEnabledPrivateApiPath("/api/files/invalid"), true);
  assert.equal(isEnabledPrivateApiMethod("/api/files/invalid", "GET"), true);
  assert.equal(isEnabledPrivateApiMethod("/api/files/invalid", "DELETE"), true);
  assert.equal(isEnabledPrivateApiMethod("/api/files/invalid/access", "POST"), false);
  assert.equal(isEnabledPrivateApiPath("/api/files/id/delete"), false);
  assert.equal(isEnabledPrivateApiPath("/api/deletions"), true);
  assert.equal(isEnabledPrivateApiMethod("/api/deletions", "GET"), true);
  assert.equal(isEnabledPrivateApiMethod("/api/deletions", "DELETE"), false);
  assert.equal(isEnabledPrivateApiMethod("/api/deletions/reconcile", "POST"), true);
  assert.equal(isEnabledPrivateApiMethod("/api/deletions/id/retry", "POST"), true);
  assert.equal(isEnabledPrivateApiPath("/api/vault/keys"), true);
  assert.equal(isEnabledPrivateApiMethod("/api/vault/keys", "GET"), true);
  assert.equal(isEnabledPrivateApiMethod("/api/vault/keys", "POST"), true);
  assert.equal(isEnabledPrivateApiMethod("/api/vault/keys", "PATCH"), false);
  assert.equal(isEnabledPrivateApiMethod("/api/vault/keys", "PUT"), true);
  assert.equal(isEnabledPrivateApiPath("/api/settings/sessions"), true);
  assert.equal(isEnabledPrivateApiPath("/api/settings/sessions/revoke"), true);
  assert.equal(isEnabledPrivateApiPath("/api/settings/password"), true);
  assert.equal(isEnabledPrivateApiMethod("/api/settings/sessions", "POST"), false);
  assert.equal(isEnabledPrivateApiMethod("/api/settings/sessions/revoke", "POST"), true);
  assert.equal(isEnabledPrivateApiMethod("/api/folders", "GET"), true);
  assert.equal(isEnabledPrivateApiMethod("/api/folders", "POST"), true);
  assert.equal(isEnabledPrivateApiMethod("/api/folders/id", "PATCH"), true);
  assert.equal(isEnabledPrivateApiMethod("/api/folders/id", "GET"), true);
  assert.equal(isEnabledPrivateApiMethod("/api/folders/id", "DELETE"), true);
  assert.equal(isEnabledPrivateApiMethod("/api/folders/id", "POST"), false);
});

test("errors use stable envelopes without private details or caching", async () => {
  const response = apiError(404, "not_found");
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: { code: "not_found", message: "Not found." } });
  assert.match(response.headers.get("cache-control") ?? "", /no-store/);
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
});

test("central JSON validation rejects forged IDs, malformed bodies and actual oversize bytes", async () => {
  const schema = z.strictObject({ autoLockMinutes: z.number().int().min(1).max(60) });
  const request = (body: string, contentType = "application/json") => new Request("https://vault.test/api/settings", {
    method: "PATCH", headers: { "Content-Type": contentType }, body,
  });
  assert.deepEqual(await readJsonRequest(request('{"autoLockMinutes":5}'), schema, 128), { ok: true, data: { autoLockMinutes: 5 } });
  for (const forged of ["ownerId", "folderId", "publicId"]) {
    assert.deepEqual(await readJsonRequest(request(JSON.stringify({ autoLockMinutes: 5, [forged]: "attacker" })), schema), { ok: false });
  }
  assert.deepEqual(await readJsonRequest(request("{"), schema), { ok: false });
  assert.deepEqual(await readJsonRequest(request('{"autoLockMinutes":5}', "text/plain"), schema), { ok: false });
  assert.deepEqual(await readJsonRequest(request(JSON.stringify({ autoLockMinutes: 5, padding: "x".repeat(500) })), schema, 128), { ok: false });
});

test("only canonical 24-character hexadecimal IDs reach database selectors", () => {
  const id = new ObjectId();
  assert.equal(parseObjectId(id.toHexString())?.equals(id), true);
  for (const invalid of ["invalid", "a".repeat(12), "z".repeat(24), { $ne: null }, null, id]) {
    assert.equal(parseObjectId(invalid), null);
  }
});

test("resource lookups scope both ID and owner; foreign and invalid IDs are absent", async () => {
  const owner = new ObjectId();
  const other = new ObjectId();
  const id = new ObjectId();
  const file = { _id: id, ownerId: other, status: "ready", cloudinary: { publicId: "server-only", resourceType: "raw", deliveryType: "authenticated" } };
  const folder = { _id: id, ownerId: other, status: "active" };
  const job = { _id: id, ownerId: other };
  const records: Record<string, Array<typeof file | typeof folder | typeof job>> = {
    files: [file], folders: [folder], uploadJobs: [job], deletionJobs: [job],
  };
  let calls = 0;
  const db = { collection(name: string) { return {
    async findOne(selector: { _id: ObjectId; ownerId: ObjectId }) {
      calls++;
      assert.deepEqual(Object.keys(selector).sort(), ["_id", "ownerId"]);
      return records[name]?.find((record) => record._id.equals(selector._id) && record.ownerId.equals(selector.ownerId)) ?? null;
    },
  }; } } as unknown as Db;
  assert.equal(await findOwnedFile(db, owner, id.toHexString()), null);
  assert.equal(await findOwnedFolder(db, owner, id.toHexString()), null);
  assert.equal(await findOwnedUploadJob(db, owner, id.toHexString()), null);
  assert.equal(await findOwnedDeletionJob(db, owner, id.toHexString()), null);
  assert.equal(await findOwnedReadyCloudAsset(db, owner, id.toHexString()), null);
  assert.equal(await findOwnedActiveFolderId(db, owner, id.toHexString()), null);
  assert.equal(await findOwnedFile(db, other, "not-an-id"), null);
  assert.equal(calls, 6);
  assert.equal((await findOwnedReadyCloudAsset(db, other, id.toHexString()))?.publicId, "server-only");
  assert.equal((await findOwnedActiveFolderId(db, other, id.toHexString()))?.equals(id), true);
});

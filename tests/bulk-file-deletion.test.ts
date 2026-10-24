import assert from "node:assert/strict";
import test from "node:test";
import { ObjectId, type Db } from "mongodb";
import { bulkDeletionInput, queueBulkFileDeletions } from "../src/lib/deletions/bulk-file-deletion";
import { DeletionFailure } from "../src/lib/deletions/file-deletion";
import type { DeletionJob } from "../src/lib/database/models";
import { isEnabledPrivateApiMethod, isEnabledPrivateApiPath } from "../src/lib/auth/api-policy";

const owner = new ObjectId();
const foreign = new ObjectId();
const ids = [new ObjectId(), new ObjectId(), new ObjectId()];

test("bulk request is private, mutation-only, bounded, and rejects duplicate or malformed IDs", () => {
  assert.equal(isEnabledPrivateApiPath("/api/deletions/bulk"), true);
  assert.equal(isEnabledPrivateApiMethod("/api/deletions/bulk", "POST"), true);
  assert.equal(isEnabledPrivateApiMethod("/api/deletions/bulk", "GET"), false);
  assert.equal(bulkDeletionInput.safeParse({ ids: ids.map(String) }).success, true);
  assert.equal(bulkDeletionInput.safeParse({ ids: [] }).success, false);
  assert.equal(bulkDeletionInput.safeParse({ ids: Array(11).fill(ids[0].toHexString()) }).success, false);
  assert.equal(bulkDeletionInput.safeParse({ ids: [String(ids[0]), String(ids[0])] }).success, false);
  assert.equal(bulkDeletionInput.safeParse({ ids: ["arbitrary/cloudinary/public_id"] }).success, false);
  assert.equal(bulkDeletionInput.safeParse({ ids: [String(ids[0])], ownerId: String(foreign) }).success, false);
});

test("bulk queues owner-scoped file IDs and preserves exact per-item uncertainty", async () => {
  const calls: string[] = [];
  const firstJob = new ObjectId();
  const queue = async (_db: Db, requestedOwner: ObjectId, id: ObjectId) => {
    assert.ok(requestedOwner.equals(owner));
    calls.push(id.toHexString());
    if (id.equals(ids[1])) throw new DeletionFailure("not_found");
    if (id.equals(ids[2])) throw new Error("database timeout after possible commit");
    return { _id: firstJob } as DeletionJob;
  };
  const result = await queueBulkFileDeletions({} as Db, owner, ids.map(String), queue);
  assert.deepEqual(calls, ids.map(String));
  assert.deepEqual(result, [
    { id: String(ids[0]), status: "queued", jobId: String(firstJob) },
    { id: String(ids[1]), status: "not_found" },
    { id: String(ids[2]), status: "uncertain" },
  ]);
});

test("retrying the same selection returns existing durable job IDs without inventing completion", async () => {
  const jobIds = new Map(ids.map((id) => [String(id), new ObjectId()]));
  const queue = async (_db: Db, requestedOwner: ObjectId, id: ObjectId) => {
    assert.ok(requestedOwner.equals(owner));
    return { _id: jobIds.get(String(id)) } as DeletionJob;
  };
  const list = ids.map(String);
  const first = await queueBulkFileDeletions({} as Db, owner, list, queue);
  const repeated = await queueBulkFileDeletions({} as Db, owner, list, queue);
  assert.deepEqual(repeated, first);
  assert.ok(first.every((entry) => entry.status === "queued"));
});

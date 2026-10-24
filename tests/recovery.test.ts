import assert from "node:assert/strict";
import test from "node:test";
import { ObjectId, type Db } from "mongodb";
import { runRecoveryPass } from "../src/lib/recovery/run";
import { reconcileExpiredUploads } from "../src/lib/uploads/reconcile";

test("recovery pass selects only bounded due work and creates no provider calls for an empty queue", async () => {
  const queries: Record<string, unknown> = {};
  const limits: number[] = [];
  const db = { collection(name: string) {
    return { find(query: unknown) {
      queries[name] = query;
      return { sort() { return this; }, limit(value: number) { limits.push(value); return this; },
        async toArray() { return []; } };
    } };
  } } as unknown as Db;
  const never = async () => { throw new Error("provider must not be called"); };
  const result = await runRecoveryPass(db, {
    uploads: { lookup: never, readHeader: never, destroy: never },
    deletions: { remove: never },
  }, new Date("2026-01-01T00:00:00Z"), 500);
  assert.deepEqual(result, { uploads: { scanned: 0, cleaned: 0, deferred: 0 },
    deletions: { scanned: 0, completed: 0, deferred: 0 } });
  assert.deepEqual(limits, [4, 4]);
  const uploadQuery = JSON.stringify(queries.uploadJobs);
  const deletionQuery = JSON.stringify(queries.deletionJobs);
  assert.match(uploadQuery, /intentExpiresAt/);
  assert.match(uploadQuery, /leaseExpiresAt/);
  assert.match(uploadQuery, /nextAttemptAt/);
  assert.match(uploadQuery, /cancelRequestedAt/);
  assert.match(deletionQuery, /leaseExpiresAt/);
  assert.match(deletionQuery, /nextAttemptAt/);
  assert.doesNotMatch(deletionQuery, /"status":"failed"/);
});

test("orphan cleanup defers when a file record was committed before the upload status", async () => {
  const ownerId = new ObjectId();
  const fileId = new ObjectId();
  const job = { _id: new ObjectId(), ownerId, fileId };
  let checked = false;
  const db = { collection(name: string) {
    if (name === "uploadJobs") return { find: () => ({ sort() { return this; }, limit() { return this; },
      toArray: async () => [job] }) };
    if (name === "files") return { findOne: async (query: { _id: ObjectId; ownerId: ObjectId }) => {
      checked = query._id.equals(fileId) && query.ownerId.equals(ownerId);
      return { _id: fileId, status: "deleting" };
    } };
    return {};
  } } as unknown as Db;
  const never = async () => { throw new Error("must not touch a committed file"); };
  const result = await reconcileExpiredUploads(db, { lookup: never, readHeader: never, destroy: never });
  assert.equal(checked, true);
  assert.deepEqual(result, { scanned: 1, cleaned: 0, deferred: 1 });
});

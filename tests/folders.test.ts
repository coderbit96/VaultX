import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { ObjectId, type Db } from "mongodb";
import { activeAncestry, changeFolder, createFolder, FolderOperationError, listFolders } from "../src/lib/database/folders";
import { decryptFolderName, encryptFolderName, newFolderId } from "../src/lib/crypto/folder-names";
import { clearVaultKeyMaterial, installVaultRootKey } from "../src/lib/crypto/key-memory";
import type { Folder } from "../src/lib/database/models";

const ownerId = new ObjectId();
const foreignId = new ObjectId();
const vaultId = Buffer.from(randomBytes(16)).toString("base64url");
const root = new Uint8Array(randomBytes(32));
const matching = (actual: ObjectId | null, expected: ObjectId | null) => actual === null ? expected === null : expected !== null && actual.equals(expected);

function fakeDatabase() {
  const records: Folder[] = [];
  const db = {
    client: { withSession: async (fn: (session: { withTransaction: (callback: () => Promise<unknown>) => Promise<unknown> }) => Promise<unknown>) =>
      fn({ withTransaction: async (callback) => callback() }) },
    collection(name: string) {
      if (name === "owners") return { updateOne: async ({ _id }: { _id: ObjectId }) => ({ matchedCount: _id.equals(ownerId) ? 1 : 0 }) };
      if (name === "vaultKeys") return { findOne: async ({ ownerId: requested }: { ownerId: ObjectId }) => requested.equals(ownerId) ? { vaultId } : null };
      if (name !== "folders") return {};
      return {
        findOne: async (query: { _id: ObjectId; ownerId: ObjectId; status?: string }) => records.find((folder) =>
          folder._id.equals(query._id) && folder.ownerId.equals(query.ownerId) && (!query.status || folder.status === query.status)) ?? null,
        insertOne: async (folder: Folder) => { if (records.some((entry) => entry._id.equals(folder._id))) throw new Error("Duplicate ID"); records.push(folder); return { insertedId: folder._id }; },
        findOneAndUpdate: async (query: { _id: ObjectId; ownerId: ObjectId; status: string }, update: { $set: Partial<Folder> }) => {
          const folder = records.find((entry) => entry._id.equals(query._id) && entry.ownerId.equals(query.ownerId) && entry.status === query.status);
          if (!folder) return null;
          Object.assign(folder, update.$set);
          return folder;
        },
        find(query: { ownerId: ObjectId; parentFolderId: ObjectId | null | { $in: ObjectId[] }; status?: string; _id?: { $gt: ObjectId } }) {
          const found = records.filter((folder) => folder.ownerId.equals(query.ownerId) &&
            (query.parentFolderId && "$in" in query.parentFolderId
              ? query.parentFolderId.$in.some((id) => folder.parentFolderId?.equals(id))
              : matching(folder.parentFolderId, query.parentFolderId as ObjectId | null)) &&
            (!query.status || folder.status === query.status) && (!query._id || folder._id.toHexString() > query._id.$gt.toHexString()));
          return { sort: () => ({ limit: (count: number) => ({ toArray: async () => found.sort((a, b) => a._id.toHexString().localeCompare(b._id.toHexString())).slice(0, count) }) }),
            toArray: async () => found };
        },
      };
    },
  } as unknown as Db;
  return { db, records };
}

async function add(db: Db, parent: ObjectId | null, name: string) {
  const id = new ObjectId(newFolderId());
  const envelope = await encryptFolderName(id.toHexString(), name);
  return createFolder(db, ownerId, id, parent, envelope);
}

test("folder names are browser-only ciphertext bound to stable folder and vault IDs", async () => {
  installVaultRootKey(root, vaultId);
  const id = newFolderId();
  const envelope = await encryptFolderName(id, "Private folder");
  assert.equal(JSON.stringify(envelope).includes("Private folder"), false);
  assert.equal(await decryptFolderName(id, envelope), "Private folder");
  await assert.rejects(decryptFolderName(newFolderId(), envelope));
  await assert.rejects(decryptFolderName(id, { ...envelope, ciphertext: `${envelope.ciphertext[0] === "A" ? "B" : "A"}${envelope.ciphertext.slice(1)}` }));
  installVaultRootKey(new Uint8Array(randomBytes(32)), vaultId);
  await assert.rejects(decryptFolderName(id, envelope));
  clearVaultKeyMaterial();
});

test("root, deep children, siblings, rename and move preserve IDs and ownership", async () => {
  installVaultRootKey(root, vaultId);
  const { db } = fakeDatabase();
  const first = await add(db, null, "First");
  const sibling = await add(db, null, "Sibling");
  let last = first;
  for (let depth = 0; depth < 70; depth++) last = await add(db, last._id, `Level ${depth}`);
  assert.equal((await activeAncestry(db, ownerId, last._id)).length, 71);
  const rootList = await listFolders(db, ownerId, null);
  assert.equal(rootList.folders.length, 2);
  const renamed = await changeFolder(db, ownerId, first._id, { nameEncrypted: await encryptFolderName(first._id.toHexString(), "Renamed") });
  assert.equal(renamed._id.equals(first._id), true);
  assert.equal(await decryptFolderName(first._id.toHexString(), renamed.nameEncrypted), "Renamed");
  assert.equal(last.parentFolderId !== null, true);
  const moved = await changeFolder(db, ownerId, sibling._id, { parentFolderId: first._id });
  assert.equal(moved.parentFolderId?.equals(first._id), true);
  assert.equal((await listFolders(db, ownerId, first._id)).folders.length, 2);
  clearVaultKeyMaterial();
});

test("self, descendant, foreign and deleting branches cannot receive moves or children", async () => {
  installVaultRootKey(root, vaultId);
  const { db, records } = fakeDatabase();
  const rootFolder = await add(db, null, "Root");
  const child = await add(db, rootFolder._id, "Child");
  const grandchild = await add(db, child._id, "Grandchild");
  await assert.rejects(changeFolder(db, ownerId, rootFolder._id, { parentFolderId: rootFolder._id }), FolderOperationError);
  await assert.rejects(changeFolder(db, ownerId, rootFolder._id, { parentFolderId: grandchild._id }), FolderOperationError);
  await assert.rejects(changeFolder(db, ownerId, child._id, { parentFolderId: foreignId }), FolderOperationError);
  await assert.rejects(changeFolder(db, foreignId, child._id, { parentFolderId: null }), FolderOperationError);
  records[0].status = "deleting";
  await assert.rejects(add(db, grandchild._id, "Blocked"), FolderOperationError);
  await assert.rejects(changeFolder(db, ownerId, grandchild._id, { nameEncrypted: await encryptFolderName(grandchild._id.toHexString(), "No") }), FolderOperationError);
  await assert.rejects(listFolders(db, ownerId, child._id), FolderOperationError);
  clearVaultKeyMaterial();
});

test("depth ceiling, invalid IDs and locked key fail closed", async () => {
  installVaultRootKey(root, vaultId);
  const { db } = fakeDatabase();
  let parent: ObjectId | null = null;
  for (let i = 0; i < 128; i++) parent = (await add(db, parent, `Depth ${i}`))._id;
  await assert.rejects(add(db, parent, "Too deep"), FolderOperationError);
  await assert.rejects(encryptFolderName("invalid", "Name"));
  await assert.rejects(encryptFolderName(newFolderId(), ".."));
  clearVaultKeyMaterial();
  await assert.rejects(encryptFolderName(newFolderId(), "Locked"));
});

test("sibling pages use stable ID cursors and exclude deleting folders", async () => {
  installVaultRootKey(root, vaultId);
  const { db, records } = fakeDatabase();
  for (let i = 0; i < 105; i++) await add(db, null, `Sibling ${i}`);
  const first = await listFolders(db, ownerId, null);
  assert.equal(first.folders.length, 100);
  assert.ok(first.nextCursor);
  const second = await listFolders(db, ownerId, null, new ObjectId(first.nextCursor!));
  assert.equal(second.folders.length, 5);
  assert.equal(second.nextCursor, null);
  records[0].status = "deleting";
  assert.equal((await listFolders(db, ownerId, null)).folders.length, 100);
  clearVaultKeyMaterial();
});

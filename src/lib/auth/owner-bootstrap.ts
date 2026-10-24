import argon2 from "argon2";
import { MongoServerError, ObjectId, type Collection, type Db } from "mongodb";
import { ZxcvbnFactory } from "@zxcvbn-ts/core";
import * as common from "@zxcvbn-ts/language-common";
import * as english from "@zxcvbn-ts/language-en";
import { modelIndexes } from "../database/model-indexes";
import { ownerSchema, type Owner } from "../database/models";

// 64 MiB, three passes, one lane. The encoded hash includes a random salt and parameters.
export const ownerHashOptions = Object.freeze({
  type: argon2.argon2id,
  memoryCost: 65_536,
  timeCost: 3,
  parallelism: 1,
  hashLength: 32,
});

const strengthEstimator = new ZxcvbnFactory({
  dictionary: { ...common.dictionary, ...english.dictionary },
  graphs: common.adjacencyGraphs,
  translations: english.translations,
  useLevenshteinDistance: true,
});

export function isAcceptableOwnerPassword(password: string): boolean {
  return [...password].length >= 16 &&
    Buffer.byteLength(password, "utf8") <= 1024 &&
    !/[\p{Cc}\p{Cf}]/u.test(password) &&
    password.trim().length > 0 &&
    strengthEstimator.check(password, ["vaultx", "owner"]).score >= 3;
}

export interface OwnerBootstrapStore {
  ensureUniqueOwnerIndexes(): Promise<void>;
  hasOwner(): Promise<boolean>;
  insertOwner(owner: Owner): Promise<void>;
}

export function createMongoOwnerBootstrapStore(db: Db): OwnerBootstrapStore {
  const owners: Collection<Owner> = db.collection<Owner>("owners");
  return {
    async ensureUniqueOwnerIndexes() {
      await owners.createIndexes(modelIndexes.owners);
    },
    async hasOwner() {
      return (await owners.findOne({}, { projection: { _id: 1 } })) !== null;
    },
    async insertOwner(owner) {
      await owners.insertOne(owner);
    },
  };
}

export type BootstrapResult = "created" | "already-exists" | "invalid-password";

export async function bootstrapOwner(store: OwnerBootstrapStore, password: string): Promise<BootstrapResult> {
  // A read makes reruns friendly; the unique singleton index settles concurrent inserts.
  await store.ensureUniqueOwnerIndexes();
  if (await store.hasOwner()) return "already-exists";
  if (!isAcceptableOwnerPassword(password)) return "invalid-password";

  const owner = ownerSchema.parse({
    _id: new ObjectId("000000000000000000000001"),
    singletonKey: "vaultx-owner",
    username: "owner",
    passwordHash: await argon2.hash(password, ownerHashOptions),
    initializedAt: new Date(),
    settings: { autoLockMinutes: 15, requireLockOnOpen: true },
  });

  try {
    await store.insertOwner(owner);
    return "created";
  } catch (error) {
    if (error instanceof MongoServerError && error.code === 11000) return "already-exists";
    throw error;
  }
}

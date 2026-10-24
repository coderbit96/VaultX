import argon2 from "argon2";
import { ObjectId, type Db } from "mongodb";
import { getModelCollections, type Owner, type Session } from "../database/models";
import { vaultKeyEnvelopeSchema, type VaultKeyEnvelope } from "../crypto/vault-key-schema";
import { createMongoAuthStore, digestSessionToken } from "./session-core";
import { isAcceptableOwnerPassword, ownerHashOptions } from "./owner-bootstrap";

export type ReauthResult = { kind: "ok"; owner: Owner } | { kind: "invalid" } | { kind: "limited" };

export async function reauthenticateOwner(db: Db, ownerId: ObjectId, password: string): Promise<ReauthResult> {
  if (!await createMongoAuthStore(db).reserveLoginAttempt(new Date())) return { kind: "limited" };
  const owner = await getModelCollections(db).owners.findOne({ _id: ownerId, singletonKey: "vaultx-owner" });
  if (!owner || !await argon2.verify(owner.passwordHash, password)) return { kind: "invalid" };
  return { kind: "ok", owner };
}

export type SafeSession = Pick<Session, "createdAt" | "lastSeenAt" | "idleExpiresAt" | "expiresAt"> & {
  id: string; deviceLabel: NonNullable<Session["deviceLabel"]>; current: boolean;
};

export async function listOwnerSessions(db: Db, ownerId: ObjectId, token: string, now = new Date()): Promise<SafeSession[]> {
  const sessions = await getModelCollections(db).sessions.find({
    ownerId, expiresAt: { $gt: now }, idleExpiresAt: { $gt: now },
    lockedAt: { $exists: false }, revokedAt: { $exists: false },
  }, { projection: { _id: 1, tokenDigest: 1, createdAt: 1, lastSeenAt: 1, idleExpiresAt: 1, expiresAt: 1, deviceLabel: 1 } })
    .sort({ createdAt: -1 }).limit(500).toArray();
  const currentDigest = digestSessionToken(token);
  return sessions.map((session) => ({
    id: session._id.toHexString(),
    createdAt: session.createdAt, lastSeenAt: session.lastSeenAt,
    idleExpiresAt: session.idleExpiresAt, expiresAt: session.expiresAt,
    deviceLabel: session.deviceLabel ?? "Other browser", current: session.tokenDigest === currentDigest,
  }));
}

export async function revokeOwnedSession(db: Db, ownerId: ObjectId, sessionId: ObjectId): Promise<boolean> {
  const result = await getModelCollections(db).sessions.deleteOne({ _id: sessionId, ownerId });
  return result.deletedCount === 1;
}

export async function changeOwnerLoginPassword(
  db: Db, ownerId: ObjectId, oldHash: string, newPassword: string,
): Promise<"changed" | "conflict" | "weak"> {
  if (!isAcceptableOwnerPassword(newPassword) || await argon2.verify(oldHash, newPassword)) return "weak";
  const replacement = await argon2.hash(newPassword, ownerHashOptions);
  const { owners, sessions, pinCredentials, deviceCredentials } = getModelCollections(db);
  return db.client.withSession((session) => session.withTransaction(async () => {
    const updated = await owners.updateOne(
      { _id: ownerId, singletonKey: "vaultx-owner", passwordHash: oldHash },
      { $set: { passwordHash: replacement } }, { session },
    );
    if (updated.matchedCount !== 1) return "conflict" as const;
    await sessions.deleteMany({ ownerId }, { session });
    await pinCredentials.deleteMany({ ownerId }, { session });
    await deviceCredentials.deleteMany({ ownerId }, { session });
    return "changed" as const;
  }));
}

export async function saveRotatedVaultEnvelope(
  db: Db, ownerId: ObjectId, previousRevision: number, proposed: VaultKeyEnvelope,
): Promise<"changed" | "conflict"> {
  const validated = vaultKeyEnvelopeSchema.parse(proposed);
  const { vaultKeys, sessions } = getModelCollections(db);
  return db.client.withSession((session) => session.withTransaction(async () => {
    const current = await vaultKeys.findOne({ ownerId }, { session });
    if (!current || current.revision !== previousRevision || validated.revision !== previousRevision + 1
      || validated.vaultId !== current.vaultId || validated.version !== current.version
      || JSON.stringify(validated.recovery) !== JSON.stringify(current.recovery)
      || JSON.stringify(validated.password) === JSON.stringify(current.password)) return "conflict" as const;
    const updated = await vaultKeys.updateOne(
      { _id: current._id, ownerId, revision: previousRevision },
      { $set: { revision: validated.revision, password: validated.password } }, { session },
    );
    if (updated.matchedCount !== 1) return "conflict" as const;
    await sessions.deleteMany({ ownerId }, { session });
    return "changed" as const;
  }));
}

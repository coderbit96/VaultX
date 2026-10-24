import { timingSafeEqual } from "node:crypto";
import type { JWT } from "next-auth/jwt";
import { digestSessionToken } from "./session-core";

export function isBoundAuthToken(jwt: JWT | null, mongoToken: string, ownerId: string): boolean {
  if (!jwt || jwt.ownerId !== ownerId || typeof jwt.sessionDigest !== "string" || !/^[a-f0-9]{64}$/.test(jwt.sessionDigest)) return false;
  const expected = Buffer.from(digestSessionToken(mongoToken), "hex");
  const supplied = Buffer.from(jwt.sessionDigest, "hex");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

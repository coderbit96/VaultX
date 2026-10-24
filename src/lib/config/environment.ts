import { readCloudinaryConfig } from "@/lib/cloudinary/config";
import { readDatabaseConfig } from "@/lib/database/config";
import { z } from "zod";

export type EnvironmentStatus = {
  mongodb: "configured" | "invalid";
  cloudinary: "configured" | "invalid";
  auth: "configured" | "invalid";
  issues: string[];
};

/** Validate existing service variables without returning or printing their values. */
export function checkEnvironment(env: Record<string, string | undefined> = process.env): EnvironmentStatus {
  const issues: string[] = [];
  let mongodb: EnvironmentStatus["mongodb"] = "configured";
  let cloudinary: EnvironmentStatus["cloudinary"] = "configured";
  let auth: EnvironmentStatus["auth"] = "configured";
  try {
    readDatabaseConfig(env);
  } catch {
    mongodb = "invalid";
    issues.push("Check MONGODB_URI and MONGODB_DB_NAME in .env.local.");
  }
  try {
    readCloudinaryConfig(env);
  } catch {
    cloudinary = "invalid";
    issues.push("Check CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET in .env.local.");
  }
  if (!z.email().safeParse(env.AUTH_OWNER_EMAIL?.trim()).success) {
    auth = "invalid";
    issues.push("Set a valid AUTH_OWNER_EMAIL in .env.local.");
  }
  if (!env.AUTH_SECRET || Buffer.byteLength(env.AUTH_SECRET, "utf8") < 32) {
    auth = "invalid";
    issues.push("Set AUTH_SECRET to at least 32 random bytes in .env.local.");
  }
  return { mongodb, cloudinary, auth, issues };
}

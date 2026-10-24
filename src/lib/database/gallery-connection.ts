import mongoose, { type Connection } from "mongoose";
import type { MongoClient } from "mongodb";
import { getDatabase, DatabaseUnavailableError } from "./client";

type SharedConnection = { client: MongoClient; connection: Connection };
const globalWithGallery = globalThis as typeof globalThis & { vaultxGalleryConnection?: SharedConnection };

/** Attach Mongoose to the existing MongoClient pool and configured database. */
export async function getGalleryConnection(): Promise<Connection> {
  const db = await getDatabase();
  const cached = globalWithGallery.vaultxGalleryConnection;
  if (cached?.client === db.client && cached.connection.readyState === 1) return cached.connection;
  try {
    const base = mongoose.createConnection();
    base.set("bufferCommands", false);
    base.set("autoIndex", false);
    base.set("autoCreate", false);
    base.setClient(db.client);
    const connection = base.useDb(db.databaseName, { useCache: true });
    globalWithGallery.vaultxGalleryConnection = { client: db.client, connection };
    return connection;
  } catch {
    throw new DatabaseUnavailableError();
  }
}

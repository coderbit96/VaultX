import { MongoClient, type Db } from "mongodb";
import { DatabaseConfigError, readDatabaseConfig } from "./config";

export class DatabaseUnavailableError extends Error {
  constructor() {
    super("MongoDB is unavailable. Check the Atlas cluster, database user, and IP access list.");
    this.name = "DatabaseUnavailableError";
  }
}

type ConnectionCache = {
  client: MongoClient | null;
  promise: Promise<MongoClient> | null;
};

const globalWithMongo = globalThis as typeof globalThis & {
  vaultxMongoCache?: ConnectionCache;
};

// Reuse the driver's pool across requests and Next.js development reloads.
const cache = (globalWithMongo.vaultxMongoCache ??= { client: null, promise: null });

export async function getDatabase(): Promise<Db> {
  const config = readDatabaseConfig();
  // A fixed loopback-only override supports disposable local integration tests.
  // Atlas connections always retain strict TLS verification.
  const localTest = process.env.VAULTX_LOCAL_MONGO_TEST === "1"
    && config.uri === "mongodb://127.0.0.1:3103/?directConnection=true";
  if (process.env.VAULTX_LOCAL_MONGO_TEST === "1" && !localTest) throw new DatabaseUnavailableError();

  if (!cache.promise) {
    let client: MongoClient;
    try {
      client = new MongoClient(config.uri, {
        appName: "VaultX",
        tls: !localTest,
        tlsAllowInvalidCertificates: false,
        tlsAllowInvalidHostnames: false,
        maxPoolSize: 10,
        serverSelectionTimeoutMS: 5000,
        connectTimeoutMS: 5000,
      });
    } catch {
      throw new DatabaseUnavailableError();
    }

    cache.promise = client
      .connect()
      .then(() => {
        cache.client = client;
        return client;
      })
      .catch(async () => {
        cache.promise = null;
        cache.client = null;
        await client.close().catch(() => undefined);
        // Driver errors can contain connection details. Never expose them.
        throw new DatabaseUnavailableError();
      });
  }

  return (await cache.promise).db(config.name);
}

export async function pingDatabase(): Promise<void> {
  try {
    const database = await getDatabase();
    await database.command({ ping: 1 });
  } catch (error) {
    if (error instanceof DatabaseConfigError) {
      throw error;
    }
    throw new DatabaseUnavailableError();
  }
}

export async function closeDatabaseConnection(): Promise<void> {
  const client = cache.client;
  cache.client = null;
  cache.promise = null;
  if (client) {
    await client.close();
  }
}

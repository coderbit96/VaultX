export class DatabaseConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatabaseConfigError";
  }
}

export type DatabaseConfig = {
  uri: string;
  name: string;
};

export function readDatabaseConfig(
  env: Record<string, string | undefined> = process.env,
): DatabaseConfig {
  const uri = env.MONGODB_URI;
  const name = env.MONGODB_DB_NAME;

  if (!uri) {
    throw new DatabaseConfigError("MONGODB_URI is missing. Add it to .env.local.");
  }
  if (uri !== uri.trim() || /\s/.test(uri) || !/^mongodb(?:\+srv)?:\/\//.test(uri)) {
    throw new DatabaseConfigError(
      "MONGODB_URI must be a single-line MongoDB connection string with no surrounding spaces.",
    );
  }
  if (!name) {
    throw new DatabaseConfigError("MONGODB_DB_NAME is missing. Add it to .env.local.");
  }
  if (name !== name.trim() || !/^[^/\\."$*<>:|?\s\x00]+$/.test(name)) {
    throw new DatabaseConfigError("MONGODB_DB_NAME is not a valid MongoDB database name.");
  }

  return { uri, name };
}

import type { AuthStore } from "./session-core";
import { authenticateSession } from "./session-core";

// Routes are reserved until encrypted media delivery exists. Deny before lookup.
export async function privateAssetStatus(store: AuthStore, token: string | undefined, now = new Date()): Promise<401 | 404> {
  return await authenticateSession(store, token, now) ? 404 : 401;
}

export const privateApiHeaders = {
  "Cache-Control": "private, no-store, max-age=0",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  Vary: "Cookie",
} as const;

const messages = {
  unauthorized: "Authentication required.",
  forbidden: "Request denied.",
  invalid_request: "Invalid request.",
  not_found: "Not found.",
  unavailable: "Service temporarily unavailable.",
  invalid_credentials: "Invalid credentials.",
  rate_limited: "Too many attempts. Try again later.",
  method_not_allowed: "Method not allowed.",
  conflict: "Vault keys are already initialized.",
  migration_required: "Existing vault data needs a reviewed migration before key setup.",
  vault_setup_required: "Finish the encrypted vault-key and recovery setup before uploading.",
  upload_conflict: "Upload state does not permit this action.",
  upload_verification_failed: "Stored object verification failed.",
  deletion_conflict: "Deletion cannot start for this file.",
  settings_conflict: "Settings changed in another session. Reload and try again.",
  weak_password: "Choose a different, stronger password of at least 16 characters.",
} as const;

export type ApiErrorCode = keyof typeof messages;

export function apiError(status: number, code: ApiErrorCode, extraHeaders?: HeadersInit): Response {
  const headers = new Headers(privateApiHeaders);
  if (extraHeaders) new Headers(extraHeaders).forEach((value, key) => headers.set(key, value));
  return Response.json({ error: { code, message: messages[code] } }, {
    status, headers,
  });
}

export function apiOk(data: Record<string, unknown>): Response {
  return Response.json(data, { headers: privateApiHeaders });
}

export function isPrivateApiPath(pathname: string): boolean {
  return ["vault", "files", "folders", "albums", "uploads", "deletions", "settings"]
    .some((prefix) => pathname === `/api/${prefix}` || pathname.startsWith(`/api/${prefix}/`));
}

// New private endpoints stay closed until reviewed and explicitly added here.
export function isEnabledPrivateApiPath(pathname: string): boolean {
  return pathname === "/api/settings" || pathname === "/api/settings/pin" || pathname === "/api/settings/passkeys" || pathname === "/api/settings/passkeys/options" || pathname === "/api/settings/passkeys/verify"
    || pathname === "/api/settings/sessions" || pathname === "/api/settings/sessions/revoke" || pathname === "/api/settings/password"
    || pathname === "/api/vault/keys" || pathname === "/api/vault/summary" || pathname === "/api/vault/gallery" || pathname === "/api/folders" || pathname === "/api/albums"
    || pathname === "/api/files" || pathname === "/api/deletions" || pathname === "/api/deletions/bulk" || pathname === "/api/deletions/reconcile" || /^\/api\/deletions\/[^/]+\/retry$/.test(pathname)
    || pathname === "/api/uploads/init" || pathname === "/api/uploads/complete"
    || /^\/api\/uploads\/[^/]+$/.test(pathname) || /^\/api\/uploads\/[^/]+\/ciphertext$/.test(pathname) || /^\/api\/files\/[^/]+$/.test(pathname)
    || /^\/api\/folders\/[^/]+$/.test(pathname) || /^\/api\/albums\/[^/]+$/.test(pathname) || /^\/api\/files\/[^/]+\/(?:access|download|thumbnail)$/.test(pathname);
}

export function isEnabledPrivateApiMethod(pathname: string, method: string): boolean {
  if (pathname === "/api/settings") return ["GET", "PATCH"].includes(method);
  if (pathname === "/api/settings/pin") return ["GET", "POST", "DELETE"].includes(method);
  if (pathname === "/api/settings/passkeys") return ["GET", "DELETE"].includes(method);
  if (pathname === "/api/settings/passkeys/options" || pathname === "/api/settings/passkeys/verify") return method === "POST";
  if (pathname === "/api/settings/sessions") return method === "GET";
  if (pathname === "/api/settings/sessions/revoke" || pathname === "/api/settings/password") return method === "POST";
  if (pathname === "/api/vault/keys") return ["GET", "POST", "PUT"].includes(method);
  if (pathname === "/api/vault/summary") return method === "GET";
  if (pathname === "/api/vault/gallery") return method === "GET";
  if (pathname === "/api/deletions") return method === "GET";
  if (pathname === "/api/deletions/bulk") return method === "POST";
  if (pathname === "/api/deletions/reconcile") return method === "POST";
  if (/^\/api\/deletions\/[^/]+\/retry$/.test(pathname)) return method === "POST";
  if (pathname === "/api/folders") return ["GET", "POST"].includes(method);
  if (pathname === "/api/albums") return ["GET", "POST"].includes(method);
  if (pathname === "/api/uploads/init") return method === "POST";
  if (pathname === "/api/uploads/complete") return method === "POST";
  if (/^\/api\/uploads\/[^/]+$/.test(pathname)) return ["GET", "DELETE"].includes(method);
  if (/^\/api\/uploads\/[^/]+\/ciphertext$/.test(pathname)) return method === "PUT";
  if (pathname === "/api/files") return method === "GET";
  if (/^\/api\/files\/[^/]+$/.test(pathname)) return ["GET", "PATCH", "DELETE"].includes(method);
  if (/^\/api\/folders\/[^/]+$/.test(pathname)) return ["GET", "PATCH", "DELETE"].includes(method);
  if (/^\/api\/albums\/[^/]+$/.test(pathname)) return ["PATCH", "DELETE"].includes(method);
  return method === "GET";
}

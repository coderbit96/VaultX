import type { NextRequest } from "next/server";
import { authorizeOwnerApi } from "@/lib/auth/owner-api";
import { apiOk } from "@/lib/auth/api-policy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Server-backed heartbeat: both Auth.js and the MongoDB session must be valid.
export async function POST(request: NextRequest): Promise<Response> {
  const authorized = await authorizeOwnerApi(request);
  return authorized.ok ? apiOk({ ok: true }) : authorized.response;
}

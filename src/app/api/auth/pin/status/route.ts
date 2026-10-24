import type { NextRequest } from "next/server";
import { getDatabase } from "@/lib/database";
import { apiError, apiOk } from "@/lib/auth/api-policy";
import { deviceDigest, pinCookieName } from "@/lib/auth/pin";
import { getModelCollections } from "@/lib/database/models";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<Response> {
  const token = request.cookies.get(pinCookieName(process.env.NODE_ENV === "production"))?.value;
  const digest = token && deviceDigest(token);
  if (!digest) return apiOk({ enabled: false });
  try {
    const found = await getModelCollections(await getDatabase()).pinCredentials.findOne({
      deviceDigest: digest, expiresAt: { $gt: new Date() },
    }, { projection: { _id: 1 } });
    return apiOk({ enabled: Boolean(found) });
  } catch { return apiError(503, "unavailable"); }
}

import { pingDatabase } from "@/lib/database";
import { apiError, apiOk } from "@/lib/auth/api-policy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  if (process.env.NODE_ENV !== "development") {
    return new Response(null, {
      status: 404,
      headers: { "Cache-Control": "no-store" },
    });
  }

  try {
    await pingDatabase();
    return apiOk({ status: "ok" });
  } catch {
    return apiError(503, "unavailable");
  }
}

import type { NextRequest } from "next/server";
import { privateCiphertextRoute } from "@/lib/auth/private-media-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return privateCiphertextRoute(request, (await params).id);
}

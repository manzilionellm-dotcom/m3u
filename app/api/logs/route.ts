import type { NextRequest } from "next/server";
import { isAdmin, unauthorized } from "@/lib/auth";
import { listLogs, statsByToken } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Recent request logs + per-playlist aggregate stats (admin only). */
export async function GET(req: NextRequest) {
  if (!isAdmin(req)) return unauthorized();
  const token = req.nextUrl.searchParams.get("token") ?? undefined;
  const limit = Math.min(1000, Number.parseInt(req.nextUrl.searchParams.get("limit") ?? "200", 10) || 200);
  return Response.json({
    logs: listLogs({ token, limit }),
    stats: statsByToken(),
  });
}

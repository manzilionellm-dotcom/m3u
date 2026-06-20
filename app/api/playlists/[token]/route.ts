import type { NextRequest } from "next/server";
import { isAdmin, unauthorized } from "@/lib/auth";
import { randomToken } from "@/lib/crypto";
import { publicBaseUrl } from "@/lib/http";
import { getPlaylist, updatePlaylist } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Manage a single output playlist: enable/disable, rotate its key (revokes the
 * old URL), or override its rate limit.
 */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  if (!isAdmin(req)) return unauthorized();
  const { token } = await ctx.params;
  if (!getPlaylist(token)) return Response.json({ error: "Not found" }, { status: 404 });

  let body: { active?: boolean; rotateKey?: boolean; rateLimitRpm?: number };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const patch: Parameters<typeof updatePlaylist>[1] = {};
  if (typeof body.active === "boolean") patch.active = body.active;
  if (body.rotateKey) patch.key = randomToken(12);
  if (typeof body.rateLimitRpm === "number" && body.rateLimitRpm >= 0) {
    patch.rateLimitRpm = body.rateLimitRpm;
  }

  const updated = updatePlaylist(token, patch)!;
  const base = publicBaseUrl(req);
  return Response.json({
    playlist: {
      ...updated,
      url: `${base}/api/playlist/${encodeURIComponent(updated.token)}.m3u?key=${encodeURIComponent(updated.key)}`,
    },
  });
}

import type { NextRequest } from "next/server";
import { isAdmin, unauthorized } from "@/lib/auth";
import { deleteSource, getSource } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Delete a source and all of its generated output playlists. */
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  if (!isAdmin(req)) return unauthorized();
  const { id } = await ctx.params;
  if (!getSource(id)) return Response.json({ error: "Not found" }, { status: 404 });
  deleteSource(id);
  return Response.json({ ok: true });
}

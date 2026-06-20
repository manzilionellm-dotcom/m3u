import type { NextRequest } from "next/server";
import { getAdminKey } from "./config";
import { safeEqual } from "./crypto";

/**
 * Admin authentication for the management API.
 *
 * Accepts the admin key via `Authorization: Bearer <key>` or the
 * `x-admin-key` header. Comparison is constant-time.
 */
export function isAdmin(req: NextRequest): boolean {
  const provided = bearer(req) ?? req.headers.get("x-admin-key") ?? "";
  if (!provided) return false;
  return safeEqual(provided, getAdminKey());
}

function bearer(req: NextRequest): string | null {
  const h = req.headers.get("authorization");
  if (!h) return null;
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

export function unauthorized(message = "Unauthorized"): Response {
  return Response.json({ error: message }, { status: 401 });
}

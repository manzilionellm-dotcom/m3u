import type { NextRequest } from "next/server";
import { config } from "@/lib/config";
import { openTarget } from "@/lib/crypto";
import { clientIp, clientUa, publicBaseUrl } from "@/lib/http";
import { maybeSweep, rateLimit } from "@/lib/ratelimit";
import { proxyTarget } from "@/lib/relay";
import { addLog, getPlaylist } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ token: string; path: string[] }> };

/**
 * The authenticated relay/proxy endpoint.
 *
 * Path shape: /api/relay/<token>/<exp>/<blob>[.ext]
 *  - token: which private playlist this link belongs to
 *  - exp:   absolute unix expiry (bound into the encrypted blob)
 *  - blob:  AES-GCM sealed upstream URL (see lib/crypto)
 *
 * Validates the playlist, rate-limits, decrypts the target, then streams the
 * upstream response back — rewriting nested HLS manifests on the fly.
 */
async function handle(req: NextRequest, ctx: Params, method: "GET" | "HEAD") {
  const started = Date.now();
  maybeSweep();

  const { token, path } = await ctx.params;
  const ip = clientIp(req);
  const ua = clientUa(req);

  const log = (
    status: number,
    bytes: number,
    cache: "hit" | "miss" | "bypass",
    upstreamHost?: string,
    rateLimited = false,
  ) =>
    addLog({
      ts: Date.now(),
      kind: "relay",
      token,
      ip,
      method,
      upstreamHost,
      status,
      bytes,
      ms: Date.now() - started,
      cache,
      rateLimited,
      ua,
    });

  const playlist = getPlaylist(token);
  if (!playlist || !playlist.active) {
    log(403, 0, "bypass");
    return new Response("Forbidden", { status: 403 });
  }

  if (path.length < 2) {
    log(400, 0, "bypass");
    return new Response("Bad relay path", { status: 400 });
  }
  const exp = Number.parseInt(path[0], 10);
  // Last segment carries the blob (+ optional extension hint). Re-join in case
  // base64url contained no slashes but defensively support extra segments.
  const blobRaw = path.slice(1).join("/");
  const blob = blobRaw.replace(/\.[a-z0-9]{1,5}$/i, "");

  // Rate limit per playlist token.
  const rl = rateLimit(`rl:${token}`, playlist.rateLimitRpm ?? config.rateLimitRpm, config.rateLimitBurst);
  if (!rl.allowed) {
    log(429, 0, "bypass", undefined, true);
    return new Response("Too Many Requests", {
      status: 429,
      headers: { "retry-after": String(rl.retryAfter) },
    });
  }

  const opened = openTarget(token, blob, exp);
  if (!opened.ok) {
    const status = opened.reason === "expired" ? 410 : 403;
    log(status, 0, "bypass");
    return new Response(opened.reason === "expired" ? "Link expired" : "Invalid link", { status });
  }

  const result = await proxyTarget({
    token,
    targetUrl: opened.url,
    incoming: req.headers,
    method,
    relayBase: publicBaseUrl(req),
  });

  log(result.status, result.bytes, result.cache, result.upstreamHost);

  // Attach rate-limit visibility without disturbing streamed bodies.
  const headers = new Headers(result.response.headers);
  headers.set("x-ratelimit-remaining", String(rl.remaining));
  return new Response(result.response.body, {
    status: result.response.status,
    headers,
  });
}

export async function GET(req: NextRequest, ctx: Params) {
  return handle(req, ctx, "GET");
}

export async function HEAD(req: NextRequest, ctx: Params) {
  return handle(req, ctx, "HEAD");
}

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, HEAD, OPTIONS",
      "access-control-allow-headers": "range, content-type",
      "access-control-max-age": "86400",
    },
  });
}

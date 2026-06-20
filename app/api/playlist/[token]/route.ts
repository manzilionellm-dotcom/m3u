import type { NextRequest } from "next/server";
import { config } from "@/lib/config";
import { safeEqual } from "@/lib/crypto";
import { clientIp, clientUa, publicBaseUrl } from "@/lib/http";
import { buildRelayUrl, looksLikeManifest, rewriteManifest } from "@/lib/m3u";
import { maybeSweep, rateLimit } from "@/lib/ratelimit";
import { sourceCache } from "@/lib/runtime";
import { addLog, getPlaylist, getSource } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Serve one of the 10 private output playlists.
 *
 * Authenticates the playlist token + key, fetches the (cached) upstream source
 * M3U, and rewrites every stream URL to point through the signed relay so the
 * client never sees or talks to the real origin.
 */
export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ token: string }> },
) {
  const started = Date.now();
  maybeSweep();

  // Output URLs look like /api/playlist/<token>.m3u — strip the extension.
  const raw = (await ctx.params).token;
  const token = raw.replace(/\.(m3u8?|txt)$/i, "");
  const ip = clientIp(req);
  const ua = clientUa(req);

  const log = (status: number, bytes: number, cache: "hit" | "miss" | "bypass", rateLimited = false) =>
    addLog({
      ts: Date.now(),
      kind: "playlist",
      token,
      ip,
      method: "GET",
      status,
      bytes,
      ms: Date.now() - started,
      cache,
      rateLimited,
      ua,
    });

  const playlist = getPlaylist(token);
  if (!playlist || !playlist.active) {
    log(404, 0, "bypass");
    return new Response("#EXTM3U\n# Not found\n", { status: 404 });
  }

  const key = req.nextUrl.searchParams.get("key") ?? "";
  if (!safeEqual(key, playlist.key)) {
    log(401, 0, "bypass");
    return new Response("#EXTM3U\n# Unauthorized\n", { status: 401 });
  }

  // Rate limit per playlist token.
  const rl = rateLimit(`pl:${token}`, playlist.rateLimitRpm ?? config.rateLimitRpm, config.rateLimitBurst);
  if (!rl.allowed) {
    log(429, 0, "bypass", true);
    return new Response("#EXTM3U\n# Rate limited\n", {
      status: 429,
      headers: { "retry-after": String(rl.retryAfter) },
    });
  }

  const source = getSource(playlist.sourceId);
  if (!source) {
    log(404, 0, "bypass");
    return new Response("#EXTM3U\n# Source missing\n", { status: 404 });
  }

  // Fetch + cache the upstream source playlist (coalesced across concurrent hits).
  let body: string;
  let cacheState: "hit" | "miss";
  try {
    const result = await sourceCache.wrap(source.url, config.upstreamCacheTtl, async () => {
      const res = await fetch(source.url, {
        headers: { "user-agent": "Mozilla/5.0 (compatible; M3URelay/1.0)", accept: "*/*" },
        cache: "no-store",
        redirect: "follow",
      });
      if (!res.ok) throw new Error(`upstream ${res.status}`);
      const text = await res.text();
      return { value: text, bytes: Buffer.byteLength(text) };
    });
    body = result.value;
    cacheState = result.cache;
  } catch {
    log(502, 0, "bypass");
    return new Response("#EXTM3U\n# Upstream unavailable\n", { status: 502 });
  }

  if (!looksLikeManifest(null, body)) {
    log(502, 0, cacheState);
    return new Response("#EXTM3U\n# Upstream is not a valid M3U\n", { status: 502 });
  }

  const base = publicBaseUrl(req);
  const exp = Math.floor(Date.now() / 1000) + config.relayLinkTtl;
  const rewritten = rewriteManifest(body, source.url, (abs) =>
    buildRelayUrl(base, token, abs, exp),
  );

  const bytes = Buffer.byteLength(rewritten);
  log(200, bytes, cacheState);

  return new Response(rewritten, {
    status: 200,
    headers: {
      "content-type": "application/vnd.apple.mpegurl; charset=utf-8",
      "content-disposition": `inline; filename="${token}.m3u"`,
      "cache-control": "no-store",
      "x-ratelimit-remaining": String(rl.remaining),
    },
  });
}

import { config } from "./config";
import { upstreamFetch } from "./fetch";
import { buildRelayUrl, looksLikeManifest, rewriteManifest } from "./m3u";
import { manifestCache } from "./runtime";

/**
 * Core proxy/relay: fetch an upstream target and return a Response suitable to
 * hand back to the player. HLS manifests are rewritten so nested segments and
 * sub-playlists also flow through the relay; binary media is streamed through
 * untouched (with Range support) and never buffered in memory.
 */

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
  // We re-derive these:
  "content-encoding",
  "content-length",
]);

export type ProxyResult = {
  response: Response;
  status: number;
  bytes: number;
  cache: "hit" | "miss" | "bypass";
  upstreamHost: string;
  /** When true the body is text we fully read (manifest); bytes is exact. */
  measured: boolean;
};

function upstreamHeaders(incoming: Headers, targetUrl: string): Headers {
  const h = new Headers();
  // Present a generic streaming client identity to the origin.
  h.set(
    "user-agent",
    incoming.get("user-agent") || "Mozilla/5.0 (compatible; M3URelay/1.0)",
  );
  h.set("accept", incoming.get("accept") || "*/*");
  const range = incoming.get("range");
  if (range) h.set("range", range);
  // Some origins require a referer/origin matching the host.
  try {
    const u = new URL(targetUrl);
    h.set("referer", `${u.protocol}//${u.host}/`);
  } catch {
    /* ignore */
  }
  return h;
}

function passthroughHeaders(upstream: Response): Headers {
  const h = new Headers();
  upstream.headers.forEach((value, key) => {
    if (!HOP_BY_HOP.has(key.toLowerCase())) h.set(key, value);
  });
  return h;
}

export async function proxyTarget(opts: {
  token: string;
  targetUrl: string;
  incoming: Headers;
  method: "GET" | "HEAD";
  /** Public base URL used to mint nested relay links inside rewritten manifests. */
  relayBase: string;
}): Promise<ProxyResult> {
  const { token, targetUrl, incoming, method, relayBase } = opts;
  const upstreamHost = (() => {
    try {
      return new URL(targetUrl).host;
    } catch {
      return "unknown";
    }
  })();

  // Serve cached manifests if available (single-flight + TTL handled by cache).
  const cacheKey = `m:${token}:${targetUrl}`;
  const cached = method === "GET" ? manifestCache.get(cacheKey) : undefined;
  if (cached) {
    const body = cached.body;
    return {
      response: new Response(body, {
        status: 200,
        headers: manifestResponseHeaders(cached.contentType, body),
      }),
      status: 200,
      bytes: Buffer.byteLength(body),
      cache: "hit",
      upstreamHost,
      measured: true,
    };
  }

  let upstream: Response;
  try {
    upstream = await upstreamFetch(targetUrl, {
      method,
      headers: upstreamHeaders(incoming, targetUrl),
      redirect: "follow",
      // Never let Next cache the proxied origin response.
      cache: "no-store",
    });
  } catch {
    return {
      response: Response.json({ error: "Upstream fetch failed" }, { status: 502 }),
      status: 502,
      bytes: 0,
      cache: "bypass",
      upstreamHost,
      measured: true,
    };
  }

  const contentType = upstream.headers.get("content-type");

  // For GET requests we may need to inspect/rewrite manifests. Peek only when
  // the content-type or extension suggests a playlist to avoid buffering media.
  const isManifestUrl = /\.m3u8?(?:$|\?)/i.test(targetUrl);
  const maybeManifest =
    method === "GET" &&
    upstream.ok &&
    (isManifestUrl ||
      (contentType ?? "").toLowerCase().includes("mpegurl"));

  if (maybeManifest) {
    const text = await upstream.text();
    if (looksLikeManifest(contentType, text)) {
      const exp = Math.floor(Date.now() / 1000) + config.relayLinkTtl;
      const rewritten = rewriteManifest(text, upstream.url || targetUrl, (abs) =>
        buildRelayUrl(relayBase, token, abs, exp),
      );
      const ct = contentType ?? "application/vnd.apple.mpegurl";
      manifestCache.set(
        cacheKey,
        { body: rewritten, contentType: ct },
        config.manifestCacheTtl,
        Buffer.byteLength(rewritten),
      );
      return {
        response: new Response(rewritten, {
          status: 200,
          headers: manifestResponseHeaders(ct, rewritten),
        }),
        status: 200,
        bytes: Buffer.byteLength(rewritten),
        cache: "miss",
        upstreamHost,
        measured: true,
      };
    }
    // Not actually a manifest — fall through and return the text we read.
    return {
      response: new Response(text, {
        status: upstream.status,
        headers: passthroughHeaders(upstream),
      }),
      status: upstream.status,
      bytes: Buffer.byteLength(text),
      cache: "bypass",
      upstreamHost,
      measured: true,
    };
  }

  // Stream binary media straight through (supports Range/206).
  const headers = passthroughHeaders(upstream);
  if (!headers.has("accept-ranges")) headers.set("accept-ranges", "bytes");
  const lenHeader = upstream.headers.get("content-length");
  if (lenHeader) headers.set("content-length", lenHeader);

  return {
    response: new Response(method === "HEAD" ? null : upstream.body, {
      status: upstream.status,
      headers,
    }),
    status: upstream.status,
    bytes: lenHeader ? Number.parseInt(lenHeader, 10) || 0 : 0,
    cache: "bypass",
    upstreamHost,
    measured: Boolean(lenHeader),
  };
}

function manifestResponseHeaders(contentType: string, body: string): Headers {
  return new Headers({
    "content-type": contentType,
    "content-length": String(Buffer.byteLength(body)),
    "cache-control": `public, max-age=${config.manifestCacheTtl}`,
    "access-control-allow-origin": "*",
  });
}

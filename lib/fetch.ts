import { ProxyAgent } from "undici";

/**
 * Outbound fetch for upstream (provider) requests.
 *
 * Some IPTV providers sit behind Cloudflare and block datacenter/VPS IP ranges
 * (the playlist endpoint returns 503 while a residential IP works fine). To
 * work around that, set `UPSTREAM_PROXY` to a residential/ISP HTTP proxy, e.g.
 *
 *   UPSTREAM_PROXY=http://user:pass@gw.proxyprovider.com:8000
 *
 * When set, all upstream traffic is routed through it so the provider sees a
 * residential IP. When unset, this behaves exactly like a normal `fetch`.
 */

let agent: ProxyAgent | undefined;
let configured = false;

function getAgent(): ProxyAgent | undefined {
  if (configured) return agent;
  configured = true;
  const url = process.env.UPSTREAM_PROXY?.trim();
  if (url) {
    try {
      agent = new ProxyAgent(url);
      // Avoid printing credentials embedded in the URL.
      console.warn(`[m3u] Proxy sortant actif (${safeHost(url)})`);
    } catch (err) {
      console.warn("[m3u] UPSTREAM_PROXY invalide, proxy ignoré:", err);
    }
  }
  return agent;
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "proxy";
  }
}

export function upstreamFetch(
  input: string,
  init: RequestInit = {},
  opts: { useProxy?: boolean } = {},
): Promise<Response> {
  // Default to using the proxy (when configured) unless explicitly disabled.
  const a = opts.useProxy === false ? undefined : getAgent();
  if (a) {
    // `dispatcher` is an undici extension accepted by Node's global fetch.
    return fetch(input, { ...init, dispatcher: a } as RequestInit & { dispatcher: ProxyAgent });
  }
  return fetch(input, init);
}

/**
 * Heavy media segments (video/audio chunks) — these should usually bypass the
 * residential proxy to avoid huge per-GB costs, since most providers only block
 * the playlist endpoint, not the segment CDN.
 */
export function isLikelyMediaSegment(url: string): boolean {
  return /\.(ts|m4s|mp4|m4a|aac|mp3|webm|mkv|avi)(?:$|\?)/i.test(url);
}

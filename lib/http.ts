import type { NextRequest } from "next/server";
import { config } from "./config";

/** Best-effort client IP from common proxy headers. */
export function clientIp(req: NextRequest): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return (
    req.headers.get("x-real-ip") ||
    req.headers.get("cf-connecting-ip") ||
    "unknown"
  );
}

/**
 * Resolve the public base URL used when minting absolute output/relay URLs.
 * Prefers the configured PUBLIC_BASE_URL, otherwise derives it from the request
 * (honouring forwarded proto/host so it works behind a CDN/load balancer).
 */
export function publicBaseUrl(req: NextRequest): string {
  if (config.publicBaseUrl) return config.publicBaseUrl;
  const proto = req.headers.get("x-forwarded-proto") || req.nextUrl.protocol.replace(":", "");
  const host = req.headers.get("x-forwarded-host") || req.headers.get("host") || req.nextUrl.host;
  return `${proto}://${host}`;
}

export function clientUa(req: NextRequest): string {
  return req.headers.get("user-agent") || "";
}

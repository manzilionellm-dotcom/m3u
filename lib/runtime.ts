import { TtlCache } from "./cache";
import { config } from "./config";

/**
 * Process-wide singletons. Module state persists across requests within a
 * server instance, giving us a shared cache + rate-limit surface.
 */

/** Caches the fetched upstream source playlist (text), keyed by source URL. */
export const sourceCache = new TtlCache<string>(config.maxCacheBytes);

/** Caches small nested HLS manifests proxied through the relay (text body). */
export const manifestCache = new TtlCache<{ body: string; contentType: string }>(
  config.maxCacheBytes,
);

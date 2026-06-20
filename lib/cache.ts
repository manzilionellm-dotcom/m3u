/**
 * In-memory TTL cache with a byte budget and request coalescing.
 *
 * Used for the upstream source playlist and for small nested HLS manifests so
 * bursts of viewers don't hammer the origin. Binary media segments are NOT
 * cached here (they stream through); only text manifests and small payloads are
 * worth holding in process memory.
 */

type Entry<T> = {
  value: T;
  expires: number;
  bytes: number;
};

export class TtlCache<T> {
  private map = new Map<string, Entry<T>>();
  private inflight = new Map<string, Promise<T>>();
  private currentBytes = 0;

  constructor(private maxBytes: number) {}

  get(key: string): T | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (e.expires < Date.now()) {
      this.map.delete(key);
      this.currentBytes -= e.bytes;
      return undefined;
    }
    // LRU-ish: refresh recency.
    this.map.delete(key);
    this.map.set(key, e);
    return e.value;
  }

  set(key: string, value: T, ttlSeconds: number, bytes: number): void {
    if (bytes > this.maxBytes) return; // too big to cache
    const existing = this.map.get(key);
    if (existing) this.currentBytes -= existing.bytes;
    this.map.set(key, { value, expires: Date.now() + ttlSeconds * 1000, bytes });
    this.currentBytes += bytes;
    this.evictIfNeeded();
  }

  private evictIfNeeded() {
    while (this.currentBytes > this.maxBytes && this.map.size > 0) {
      const oldest = this.map.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      const e = this.map.get(oldest);
      this.map.delete(oldest);
      if (e) this.currentBytes -= e.bytes;
    }
  }

  /**
   * Get-or-load with single-flight coalescing: concurrent misses for the same
   * key share one upstream fetch. Returns `{ value, cache }`.
   */
  async wrap(
    key: string,
    ttlSeconds: number,
    loader: () => Promise<{ value: T; bytes: number }>,
  ): Promise<{ value: T; cache: "hit" | "miss" }> {
    const hit = this.get(key);
    if (hit !== undefined) return { value: hit, cache: "hit" };

    const pending = this.inflight.get(key);
    if (pending) return { value: await pending, cache: "hit" };

    const p = (async () => {
      const { value, bytes } = await loader();
      this.set(key, value, ttlSeconds, bytes);
      return value;
    })();
    this.inflight.set(key, p);
    try {
      const value = await p;
      return { value, cache: "miss" };
    } finally {
      this.inflight.delete(key);
    }
  }
}

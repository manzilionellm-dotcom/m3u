/**
 * Per-key token-bucket rate limiter (in-memory).
 *
 * Keyed by playlist token so each of the 10 private outputs is throttled
 * independently. A token bucket gives a smooth sustained rate plus a burst
 * allowance, which suits players that fire many segment requests in quick
 * succession then idle.
 */

type Bucket = {
  tokens: number;
  updated: number;
};

const buckets = new Map<string, Bucket>();

export type RateResult = {
  allowed: boolean;
  remaining: number;
  /** Seconds until at least one token is available again. */
  retryAfter: number;
  limit: number;
};

export function rateLimit(key: string, rpm: number, burst: number): RateResult {
  const now = Date.now();
  const refillPerMs = rpm / 60_000;
  let b = buckets.get(key);
  if (!b) {
    b = { tokens: burst, updated: now };
    buckets.set(key, b);
  }

  // Refill based on elapsed time, capped at burst.
  const elapsed = now - b.updated;
  b.tokens = Math.min(burst, b.tokens + elapsed * refillPerMs);
  b.updated = now;

  if (b.tokens >= 1) {
    b.tokens -= 1;
    return {
      allowed: true,
      remaining: Math.floor(b.tokens),
      retryAfter: 0,
      limit: rpm,
    };
  }

  const needed = 1 - b.tokens;
  const retryAfter = refillPerMs > 0 ? Math.ceil(needed / refillPerMs / 1000) : 60;
  return { allowed: false, remaining: 0, retryAfter, limit: rpm };
}

/** Periodically drop idle buckets so the map doesn't grow unbounded. */
const SWEEP_MS = 5 * 60_000;
let lastSweep = Date.now();
export function maybeSweep() {
  const now = Date.now();
  if (now - lastSweep < SWEEP_MS) return;
  lastSweep = now;
  for (const [k, b] of buckets) {
    if (now - b.updated > SWEEP_MS) buckets.delete(k);
  }
}

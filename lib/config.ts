import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Central configuration for the M3U relay platform.
 *
 * Secrets (admin key + relay master secret) are read from the environment when
 * available. For local/dev use they are generated once and persisted to
 * `.data/secrets.json` so the platform is usable out-of-the-box without manual
 * setup. In production you should always set these via environment variables.
 */

export const DATA_DIR = path.join(process.cwd(), ".data");

/** Exactly how many private output playlists are minted per authorized source. */
export const OUTPUTS_PER_SOURCE = 10;

function ensureDataDir() {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
}

type PersistedSecrets = {
  adminKey: string;
  relaySecret: string;
};

let cachedSecrets: PersistedSecrets | null = null;

function loadOrCreateSecrets(): PersistedSecrets {
  if (cachedSecrets) return cachedSecrets;

  const fromEnv: Partial<PersistedSecrets> = {
    adminKey: process.env.ADMIN_KEY,
    relaySecret: process.env.RELAY_SECRET,
  };

  // If both provided via env, use them directly.
  if (fromEnv.adminKey && fromEnv.relaySecret) {
    cachedSecrets = {
      adminKey: fromEnv.adminKey,
      relaySecret: fromEnv.relaySecret,
    };
    return cachedSecrets;
  }

  // Otherwise fall back to a persisted dev secrets file, generating any missing
  // values once and reusing them across restarts.
  ensureDataDir();
  const secretsPath = path.join(DATA_DIR, "secrets.json");
  let persisted: Partial<PersistedSecrets> = {};
  if (existsSync(secretsPath)) {
    try {
      persisted = JSON.parse(readFileSync(secretsPath, "utf8"));
    } catch {
      persisted = {};
    }
  }

  const secrets: PersistedSecrets = {
    adminKey: fromEnv.adminKey ?? persisted.adminKey ?? randomBytes(24).toString("base64url"),
    relaySecret:
      fromEnv.relaySecret ?? persisted.relaySecret ?? randomBytes(32).toString("base64url"),
  };

  // Persist anything that wasn't already on disk so it survives restarts in dev.
  if (secrets.adminKey !== persisted.adminKey || secrets.relaySecret !== persisted.relaySecret) {
    try {
      writeFileSync(secretsPath, JSON.stringify(secrets, null, 2), { mode: 0o600 });
      if (!fromEnv.adminKey) {
        // Surface the generated admin key so the operator can actually log in.
        console.warn(
          `[m3u] Generated admin key (set ADMIN_KEY to override): ${secrets.adminKey}`,
        );
      }
    } catch (err) {
      console.warn("[m3u] Could not persist generated secrets:", err);
    }
  }

  cachedSecrets = secrets;
  return secrets;
}

export function getAdminKey(): string {
  return loadOrCreateSecrets().adminKey;
}

export function getRelaySecret(): string {
  return loadOrCreateSecrets().relaySecret;
}

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export const config = {
  /** How long a signed relay link stays valid, in seconds. Default 6h. */
  get relayLinkTtl() {
    return intFromEnv("RELAY_LINK_TTL", 6 * 60 * 60);
  },
  /** Cache TTL for the upstream source playlist fetch, in seconds. */
  get upstreamCacheTtl() {
    return intFromEnv("UPSTREAM_CACHE_TTL", 60);
  },
  /** Cache TTL for nested HLS manifests proxied through the relay, in seconds. */
  get manifestCacheTtl() {
    return intFromEnv("MANIFEST_CACHE_TTL", 3);
  },
  /** Max bytes of a single upstream response we are willing to cache in memory. */
  get maxCacheBytes() {
    return intFromEnv("MAX_CACHE_BYTES", 2 * 1024 * 1024);
  },
  /** Per-playlist sustained request rate, requests per minute. */
  get rateLimitRpm() {
    return intFromEnv("RATE_LIMIT_RPM", 600);
  },
  /** Per-playlist burst allowance (token bucket size). */
  get rateLimitBurst() {
    return intFromEnv("RATE_LIMIT_BURST", 120);
  },
  /** Optional fixed public base URL (e.g. https://cdn.example.com). */
  get publicBaseUrl(): string | undefined {
    return process.env.PUBLIC_BASE_URL?.replace(/\/+$/, "") || undefined;
  },
} as const;

import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { getRelaySecret } from "./config";

/**
 * Stateless, tamper-proof encoding of relay targets.
 *
 * Each rewritten stream URL embeds the *encrypted* upstream URL so the relay is
 * fully stateless and the real origin is never exposed to the client (private
 * CDN behaviour). Encryption uses AES-256-GCM with a key derived per-playlist
 * from the master relay secret, and the token + expiry are bound as additional
 * authenticated data (AAD) so a link cannot be replayed on another playlist or
 * after it expires.
 */

const ALGO = "aes-256-gcm";

function deriveKey(token: string): Buffer {
  // HKDF the master secret with the playlist token as salt → per-playlist key.
  return Buffer.from(
    hkdfSync("sha256", getRelaySecret(), token, "m3u-relay-target", 32),
  );
}

/** Constant-time string comparison that won't throw on length mismatch. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    // Still do a comparison to avoid leaking length via early return timing.
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

/**
 * Encrypt an upstream URL into an opaque, URL-safe blob bound to `token` and
 * `expSeconds` (absolute unix expiry).
 */
export function sealTarget(token: string, url: string, expSeconds: number): string {
  const key = deriveKey(token);
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key, iv);
  cipher.setAAD(Buffer.from(`${token}.${expSeconds}`));
  const ciphertext = Buffer.concat([cipher.update(url, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Layout: iv(12) | tag(16) | ciphertext
  return Buffer.concat([iv, tag, ciphertext]).toString("base64url");
}

export type OpenResult =
  | { ok: true; url: string }
  | { ok: false; reason: "invalid" | "expired" };

/** Decrypt and validate a relay blob produced by {@link sealTarget}. */
export function openTarget(token: string, blob: string, expSeconds: number): OpenResult {
  if (Number.isFinite(expSeconds) && expSeconds * 1000 < Date.now()) {
    return { ok: false, reason: "expired" };
  }
  let raw: Buffer;
  try {
    raw = Buffer.from(blob, "base64url");
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (raw.length < 12 + 16 + 1) return { ok: false, reason: "invalid" };

  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const ciphertext = raw.subarray(28);

  try {
    const decipher = createDecipheriv(ALGO, deriveKey(token), iv);
    decipher.setAAD(Buffer.from(`${token}.${expSeconds}`));
    decipher.setAuthTag(tag);
    const url = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    return { ok: true, url };
  } catch {
    // GCM auth failure → tampered token/exp/blob.
    return { ok: false, reason: "invalid" };
  }
}

export function randomToken(bytes = 16): string {
  return randomBytes(bytes).toString("base64url");
}

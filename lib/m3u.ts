import { sealTarget } from "./crypto";

/**
 * M3U / HLS playlist rewriting.
 *
 * Handles both the top-level IPTV-style provider playlist (`#EXTINF` + URL
 * lines) and nested HLS manifests (`.m3u8` with `#EXT-X-STREAM-INF`, segment
 * lines and `URI="..."` attributes such as `#EXT-X-KEY` / `#EXT-X-MEDIA`).
 *
 * Every resource reference is resolved to an absolute URL against the manifest
 * base, then replaced with a signed relay URL so the player only ever talks to
 * our proxy layer.
 */

/** Pick a player-friendly extension hint from a target URL. */
export function extFor(targetUrl: string): string {
  try {
    const { pathname } = new URL(targetUrl);
    const m = pathname.match(/\.([a-z0-9]{1,5})(?:$)/i);
    if (m) return `.${m[1].toLowerCase()}`;
  } catch {
    /* ignore */
  }
  return "";
}

/** Build a signed relay URL that encodes the encrypted upstream target. */
export function buildRelayUrl(
  baseUrl: string,
  token: string,
  targetUrl: string,
  expSeconds: number,
): string {
  const blob = sealTarget(token, targetUrl, expSeconds);
  const ext = extFor(targetUrl);
  return `${baseUrl}/api/relay/${encodeURIComponent(token)}/${expSeconds}/${blob}${ext}`;
}

function resolve(base: string, ref: string): string | null {
  try {
    return new URL(ref, base).toString();
  } catch {
    return null;
  }
}

const URI_ATTR_TAGS = /^#EXT-X-(KEY|MEDIA|I-FRAME-STREAM-INF|MAP|SESSION-KEY|PART|PRELOAD-HINT|RENDITION-REPORT)/i;

/**
 * Rewrite a manifest's resource references through the relay.
 *
 * @param text       Raw manifest body.
 * @param manifestUrl Absolute URL the manifest was fetched from (for relative resolution).
 * @param rewrite    Maps an absolute upstream URL to a relay URL.
 */
export function rewriteManifest(
  text: string,
  manifestUrl: string,
  rewrite: (absoluteUrl: string) => string,
): string {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed === "") {
      out.push(line);
      continue;
    }

    if (trimmed.startsWith("#")) {
      // Rewrite any URI="..." attribute embedded in the tag.
      if (URI_ATTR_TAGS.test(trimmed) && /URI="/i.test(trimmed)) {
        out.push(
          line.replace(/URI="([^"]*)"/gi, (full, uri: string) => {
            const abs = resolve(manifestUrl, uri);
            return abs ? `URI="${rewrite(abs)}"` : full;
          }),
        );
      } else {
        out.push(line);
      }
      continue;
    }

    // A bare resource line (segment, sub-playlist, or stream URL).
    const abs = resolve(manifestUrl, trimmed);
    out.push(abs ? rewrite(abs) : line);
  }

  return out.join("\n");
}

/** Heuristic: does this look like an HLS/M3U manifest we should rewrite? */
export function looksLikeManifest(contentType: string | null, body: string): boolean {
  const ct = (contentType ?? "").toLowerCase();
  if (
    ct.includes("mpegurl") ||
    ct.includes("vnd.apple.mpegurl") ||
    ct.includes("audio/x-mpegurl") ||
    ct.includes("application/x-mpegurl")
  ) {
    return true;
  }
  // Fall back to sniffing the body for the magic header.
  return body.slice(0, 512).includes("#EXTM3U");
}

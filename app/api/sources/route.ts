import type { NextRequest } from "next/server";
import { isAdmin, unauthorized } from "@/lib/auth";
import { OUTPUTS_PER_SOURCE } from "@/lib/config";
import { randomToken } from "@/lib/crypto";
import { publicBaseUrl } from "@/lib/http";
import {
  addPlaylists,
  addSource,
  listPlaylistsForSource,
  listSources,
  type Playlist,
  type Source,
} from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function playlistUrl(base: string, p: Playlist): string {
  return `${base}/api/playlist/${encodeURIComponent(p.token)}.m3u?key=${encodeURIComponent(p.key)}`;
}

/** List all sources with their generated private output playlists. */
export async function GET(req: NextRequest) {
  if (!isAdmin(req)) return unauthorized();
  const base = publicBaseUrl(req);
  const sources = listSources().map((s) => ({
    ...s,
    playlists: listPlaylistsForSource(s.id).map((p) => ({
      ...p,
      url: playlistUrl(base, p),
    })),
  }));
  return Response.json({ sources });
}

/**
 * Register one authorized M3U source and mint exactly
 * {@link OUTPUTS_PER_SOURCE} private output playlists for it.
 */
export async function POST(req: NextRequest) {
  if (!isAdmin(req)) return unauthorized();

  let body: { url?: string; label?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const url = (body.url ?? "").trim();
  if (!url) return Response.json({ error: "Missing 'url'" }, { status: 400 });

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return Response.json({ error: "Invalid URL" }, { status: 400 });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return Response.json({ error: "URL must be http(s)" }, { status: 400 });
  }

  const source: Source = {
    id: randomToken(8),
    url,
    label: (body.label ?? parsed.host).slice(0, 120),
    createdAt: Date.now(),
  };
  addSource(source);

  const now = Date.now();
  const playlists: Playlist[] = Array.from({ length: OUTPUTS_PER_SOURCE }, (_, i) => ({
    token: randomToken(16),
    sourceId: source.id,
    key: randomToken(12),
    label: `Output ${i + 1}`,
    active: true,
    createdAt: now,
  }));
  addPlaylists(playlists);

  const base = publicBaseUrl(req);
  return Response.json(
    {
      source,
      count: playlists.length,
      playlists: playlists.map((p) => ({ ...p, url: playlistUrl(base, p) })),
    },
    { status: 201 },
  );
}

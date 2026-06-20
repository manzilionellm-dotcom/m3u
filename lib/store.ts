import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./config";

/**
 * Tiny JSON-backed persistence layer.
 *
 * This is deliberately dependency-free: the platform is designed to run in
 * ephemeral containers and serverless functions, so the store keeps everything
 * in memory and lazily persists to `.data/store.json`. Swap this module for a
 * real database (Postgres, Redis, etc.) without touching the rest of the app.
 */

export type Source = {
  id: string;
  /** The single authorized upstream M3U URL. */
  url: string;
  label: string;
  createdAt: number;
};

export type Playlist = {
  /** Public token that appears in the private output URL. */
  token: string;
  sourceId: string;
  /** Secret key required (as `?key=`) to fetch the rewritten playlist. */
  key: string;
  /** Human label, e.g. "Output 1". */
  label: string;
  /** Disabled playlists are rejected at the playlist + relay layers. */
  active: boolean;
  createdAt: number;
  /** Optional per-playlist rate override (requests per minute). */
  rateLimitRpm?: number;
};

export type LogEntry = {
  id: number;
  ts: number;
  /** Which layer produced the log. */
  kind: "playlist" | "relay";
  token: string;
  ip: string;
  method: string;
  /** Upstream host being relayed (relay logs only). */
  upstreamHost?: string;
  status: number;
  bytes: number;
  ms: number;
  cache: "hit" | "miss" | "bypass";
  rateLimited: boolean;
  ua?: string;
};

type Db = {
  sources: Source[];
  playlists: Playlist[];
  logs: LogEntry[];
  logSeq: number;
};

const MAX_LOGS = 2000;
const STORE_PATH = path.join(DATA_DIR, "store.json");

function emptyDb(): Db {
  return { sources: [], playlists: [], logs: [], logSeq: 0 };
}

let db: Db | null = null;
let writeTimer: NodeJS.Timeout | null = null;

function load(): Db {
  if (db) return db;
  if (existsSync(STORE_PATH)) {
    try {
      const parsed = JSON.parse(readFileSync(STORE_PATH, "utf8"));
      db = { ...emptyDb(), ...parsed };
      return db!;
    } catch {
      // Corrupt store: start fresh rather than crash.
    }
  }
  db = emptyDb();
  return db;
}

/** Debounced async persistence so hot request paths never block on disk I/O. */
function schedulePersist() {
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    try {
      if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
      writeFileSync(STORE_PATH, JSON.stringify(db));
    } catch (err) {
      console.warn("[m3u] Failed to persist store:", err);
    }
  }, 250);
  // Don't keep the event loop alive solely for a pending flush.
  writeTimer.unref?.();
}

// ---- Sources -------------------------------------------------------------

export function listSources(): Source[] {
  return load().sources.slice().sort((a, b) => b.createdAt - a.createdAt);
}

export function getSource(id: string): Source | undefined {
  return load().sources.find((s) => s.id === id);
}

export function addSource(source: Source): Source {
  load().sources.push(source);
  schedulePersist();
  return source;
}

export function deleteSource(id: string): void {
  const d = load();
  d.sources = d.sources.filter((s) => s.id !== id);
  d.playlists = d.playlists.filter((p) => p.sourceId !== id);
  schedulePersist();
}

// ---- Playlists -----------------------------------------------------------

export function listPlaylists(): Playlist[] {
  return load().playlists.slice();
}

export function listPlaylistsForSource(sourceId: string): Playlist[] {
  return load().playlists.filter((p) => p.sourceId === sourceId);
}

export function getPlaylist(token: string): Playlist | undefined {
  return load().playlists.find((p) => p.token === token);
}

export function addPlaylists(playlists: Playlist[]): void {
  load().playlists.push(...playlists);
  schedulePersist();
}

export function updatePlaylist(token: string, patch: Partial<Playlist>): Playlist | undefined {
  const p = getPlaylist(token);
  if (!p) return undefined;
  Object.assign(p, patch);
  schedulePersist();
  return p;
}

// ---- Logs ----------------------------------------------------------------

export function addLog(entry: Omit<LogEntry, "id">): void {
  const d = load();
  d.logSeq += 1;
  d.logs.push({ ...entry, id: d.logSeq });
  if (d.logs.length > MAX_LOGS) {
    d.logs.splice(0, d.logs.length - MAX_LOGS);
  }
  schedulePersist();
}

export function listLogs(opts: { token?: string; limit?: number } = {}): LogEntry[] {
  const { token, limit = 200 } = opts;
  let logs = load().logs;
  if (token) logs = logs.filter((l) => l.token === token);
  return logs.slice(-limit).reverse();
}

export type TokenStats = {
  token: string;
  requests: number;
  bytes: number;
  errors: number;
  rateLimited: number;
  lastSeen: number | null;
};

export function statsByToken(): Record<string, TokenStats> {
  const out: Record<string, TokenStats> = {};
  for (const p of load().playlists) {
    out[p.token] = {
      token: p.token,
      requests: 0,
      bytes: 0,
      errors: 0,
      rateLimited: 0,
      lastSeen: null,
    };
  }
  for (const l of load().logs) {
    const s = out[l.token] ?? (out[l.token] = {
      token: l.token,
      requests: 0,
      bytes: 0,
      errors: 0,
      rateLimited: 0,
      lastSeen: null,
    });
    s.requests += 1;
    s.bytes += l.bytes;
    if (l.status >= 400) s.errors += 1;
    if (l.rateLimited) s.rateLimited += 1;
    s.lastSeen = Math.max(s.lastSeen ?? 0, l.ts);
  }
  return out;
}

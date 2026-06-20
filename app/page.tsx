"use client";

import { useCallback, useEffect, useState } from "react";

type Playlist = {
  token: string;
  key: string;
  label: string;
  active: boolean;
  url: string;
  rateLimitRpm?: number;
};

type Source = {
  id: string;
  url: string;
  label: string;
  createdAt: number;
  playlists: Playlist[];
};

type TokenStats = {
  token: string;
  requests: number;
  bytes: number;
  errors: number;
  rateLimited: number;
  lastSeen: number | null;
};

type LogEntry = {
  id: number;
  ts: number;
  kind: string;
  token: string;
  ip: string;
  status: number;
  bytes: number;
  ms: number;
  cache: string;
  rateLimited: boolean;
  upstreamHost?: string;
};

function fmtBytes(n: number): string {
  if (!n) return "0 B";
  const u = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(n) / Math.log(1024));
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
}

export default function Home() {
  const [adminKey, setAdminKey] = useState("");
  const [keyInput, setKeyInput] = useState("");
  const [url, setUrl] = useState("");
  const [label, setLabel] = useState("");
  const [sources, setSources] = useState<Source[]>([]);
  const [stats, setStats] = useState<Record<string, TokenStats>>({});
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const saved = localStorage.getItem("adminKey");
    if (saved) {
      setAdminKey(saved);
      setKeyInput(saved);
    }
  }, []);

  const authed = useCallback(
    (path: string, init: RequestInit = {}) =>
      fetch(path, {
        ...init,
        headers: { ...init.headers, "x-admin-key": adminKey, "content-type": "application/json" },
      }),
    [adminKey],
  );

  const refresh = useCallback(async () => {
    if (!adminKey) return;
    setError("");
    try {
      const [sRes, lRes] = await Promise.all([authed("/api/sources"), authed("/api/logs?limit=100")]);
      if (sRes.status === 401 || lRes.status === 401) {
        setError("Clé admin invalide.");
        return;
      }
      const s = await sRes.json();
      const l = await lRes.json();
      setSources(s.sources ?? []);
      setStats(l.stats ?? {});
      setLogs(l.logs ?? []);
    } catch {
      setError("Erreur réseau.");
    }
  }, [adminKey, authed]);

  useEffect(() => {
    if (!adminKey) return;
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [adminKey, refresh]);

  const saveKey = () => {
    localStorage.setItem("adminKey", keyInput.trim());
    setAdminKey(keyInput.trim());
  };

  const generate = async () => {
    if (!url.trim()) return;
    setBusy(true);
    setError("");
    try {
      const res = await authed("/api/sources", {
        method: "POST",
        body: JSON.stringify({ url: url.trim(), label: label.trim() || undefined }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Échec de la génération.");
      } else {
        setUrl("");
        setLabel("");
        await refresh();
      }
    } catch {
      setError("Erreur réseau.");
    } finally {
      setBusy(false);
    }
  };

  const togglePlaylist = async (token: string, active: boolean) => {
    await authed(`/api/playlists/${encodeURIComponent(token)}`, {
      method: "PATCH",
      body: JSON.stringify({ active }),
    });
    refresh();
  };

  const rotateKey = async (token: string) => {
    await authed(`/api/playlists/${encodeURIComponent(token)}`, {
      method: "PATCH",
      body: JSON.stringify({ rotateKey: true }),
    });
    refresh();
  };

  const deleteSource = async (id: string) => {
    if (!confirm("Supprimer cette source et ses 10 sorties ?")) return;
    await authed(`/api/sources/${encodeURIComponent(id)}`, { method: "DELETE" });
    refresh();
  };

  const copy = (text: string) => navigator.clipboard?.writeText(text);

  return (
    <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8 sm:px-6">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">CDN privé M3U — Relais &amp; Restream</h1>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          Une source M3U autorisée → 10 sorties privées, proxifiées, mises en cache, journalisées et limitées en débit.
        </p>
      </header>

      {/* Admin key */}
      <section className="mb-6 rounded-xl border border-black/10 bg-white p-4 dark:border-white/10 dark:bg-zinc-950">
        <label className="mb-2 block text-sm font-medium">Clé admin</label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            type="password"
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
            placeholder="ADMIN_KEY"
            className="flex-1 rounded-lg border border-black/10 bg-zinc-50 px-3 py-2 text-sm outline-none focus:border-blue-500 dark:border-white/10 dark:bg-zinc-900"
          />
          <button
            onClick={saveKey}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
          >
            Enregistrer
          </button>
        </div>
        <p className="mt-2 text-xs text-zinc-500">
          La clé est affichée dans les logs du serveur au premier démarrage si <code>ADMIN_KEY</code> n&apos;est pas définie.
        </p>
      </section>

      {error && (
        <div className="mb-4 rounded-lg border border-red-300 bg-red-50 px-4 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
          {error}
        </div>
      )}

      {/* Generate */}
      <section className="mb-8 rounded-xl border border-black/10 bg-white p-4 dark:border-white/10 dark:bg-zinc-950">
        <h2 className="mb-3 text-lg font-medium">Générer 10 sorties</h2>
        <div className="flex flex-col gap-2">
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://exemple.com/playlist.m3u (source autorisée)"
            className="rounded-lg border border-black/10 bg-zinc-50 px-3 py-2 text-sm outline-none focus:border-blue-500 dark:border-white/10 dark:bg-zinc-900"
          />
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Libellé (optionnel)"
              className="flex-1 rounded-lg border border-black/10 bg-zinc-50 px-3 py-2 text-sm outline-none focus:border-blue-500 dark:border-white/10 dark:bg-zinc-900"
            />
            <button
              onClick={generate}
              disabled={busy || !adminKey}
              className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              {busy ? "Génération…" : "Générer 10 M3U"}
            </button>
          </div>
        </div>
      </section>

      {/* Sources */}
      <section className="mb-8 space-y-6">
        {sources.length === 0 && (
          <p className="text-sm text-zinc-500">Aucune source pour l&apos;instant.</p>
        )}
        {sources.map((s) => (
          <div key={s.id} className="rounded-xl border border-black/10 bg-white p-4 dark:border-white/10 dark:bg-zinc-950">
            <div className="mb-3 flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h3 className="truncate font-medium">{s.label}</h3>
                <p className="truncate text-xs text-zinc-500">{s.url}</p>
              </div>
              <button
                onClick={() => deleteSource(s.id)}
                className="shrink-0 rounded-lg border border-red-300 px-3 py-1 text-xs text-red-600 hover:bg-red-50 dark:border-red-900 dark:hover:bg-red-950"
              >
                Supprimer
              </button>
            </div>
            <div className="space-y-2">
              {s.playlists.map((p) => {
                const st = stats[p.token];
                return (
                  <div
                    key={p.token}
                    className="flex flex-col gap-2 rounded-lg border border-black/5 bg-zinc-50 p-2 dark:border-white/5 dark:bg-zinc-900 sm:flex-row sm:items-center"
                  >
                    <span className="w-20 shrink-0 text-xs font-medium">{p.label}</span>
                    <input
                      readOnly
                      value={p.url}
                      onFocus={(e) => e.currentTarget.select()}
                      className="min-w-0 flex-1 rounded border border-black/10 bg-white px-2 py-1 font-mono text-xs dark:border-white/10 dark:bg-zinc-950"
                    />
                    <div className="flex shrink-0 items-center gap-1">
                      <button onClick={() => copy(p.url)} className="rounded border border-black/10 px-2 py-1 text-xs hover:bg-black/5 dark:border-white/10 dark:hover:bg-white/5">
                        Copier
                      </button>
                      <button onClick={() => rotateKey(p.token)} className="rounded border border-black/10 px-2 py-1 text-xs hover:bg-black/5 dark:border-white/10 dark:hover:bg-white/5">
                        Rotation clé
                      </button>
                      <button
                        onClick={() => togglePlaylist(p.token, !p.active)}
                        className={`rounded px-2 py-1 text-xs ${p.active ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300" : "bg-zinc-200 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400"}`}
                      >
                        {p.active ? "Actif" : "Inactif"}
                      </button>
                    </div>
                    {st && (
                      <span className="shrink-0 text-xs text-zinc-500">
                        {st.requests} req · {fmtBytes(st.bytes)}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </section>

      {/* Logs */}
      {logs.length > 0 && (
        <section className="rounded-xl border border-black/10 bg-white p-4 dark:border-white/10 dark:bg-zinc-950">
          <h2 className="mb-3 text-lg font-medium">Journal des requêtes</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="text-zinc-500">
                <tr>
                  <th className="py-1 pr-3">Heure</th>
                  <th className="py-1 pr-3">Type</th>
                  <th className="py-1 pr-3">Token</th>
                  <th className="py-1 pr-3">IP</th>
                  <th className="py-1 pr-3">Origine</th>
                  <th className="py-1 pr-3">Statut</th>
                  <th className="py-1 pr-3">Taille</th>
                  <th className="py-1 pr-3">ms</th>
                  <th className="py-1 pr-3">Cache</th>
                </tr>
              </thead>
              <tbody className="font-mono">
                {logs.map((l) => (
                  <tr key={l.id} className="border-t border-black/5 dark:border-white/5">
                    <td className="py-1 pr-3 whitespace-nowrap">{new Date(l.ts).toLocaleTimeString()}</td>
                    <td className="py-1 pr-3">{l.kind}</td>
                    <td className="py-1 pr-3">{l.token.slice(0, 8)}…</td>
                    <td className="py-1 pr-3">{l.ip}</td>
                    <td className="py-1 pr-3">{l.upstreamHost ?? "—"}</td>
                    <td className={`py-1 pr-3 ${l.status >= 400 ? "text-red-500" : "text-emerald-600"}`}>
                      {l.rateLimited ? "429*" : l.status}
                    </td>
                    <td className="py-1 pr-3">{fmtBytes(l.bytes)}</td>
                    <td className="py-1 pr-3">{l.ms}</td>
                    <td className="py-1 pr-3">{l.cache}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </main>
  );
}

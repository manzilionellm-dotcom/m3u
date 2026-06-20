# CDN privé M3U — Relais & Restream

Plateforme qui transforme **une seule URL M3U autorisée** en **10 URLs M3U
privées et fonctionnelles**. Chaque sortie renvoie une playlist réécrite dont
**chaque flux passe par une couche relais/proxy** maison avec
**authentification, cache, journalisation et limitation de débit**.

```
                                   ┌── /api/playlist/<token1>.m3u?key=…  (sortie 1)
 1 source M3U autorisée  ──────►   ├── /api/playlist/<token2>.m3u?key=…  (sortie 2)
 (http://provider/list.m3u)        │              … (10 au total)
                                   └── /api/playlist/<token10>.m3u?key=… (sortie 10)

 chaque flux d'une sortie  ──────►  /api/relay/<token>/<exp>/<blob>.<ext>
                                    (proxy/restream chiffré, caché, limité, journalisé)
```

## Comment ça marche

1. **Enregistrement de la source** — vous fournissez **une** URL M3U autorisée
   via le tableau de bord (ou l'API). La plateforme crée la source et génère
   **exactement 10 playlists privées**, chacune avec son propre `token`, sa clé
   secrète, sa limite de débit et ses journaux.
2. **Sortie playlist** (`/api/playlist/<token>.m3u?key=…`) — récupère la source
   amont (mise en cache), puis **réécrit chaque URL de flux** pour qu'elle pointe
   vers le relais. Le lecteur ne voit jamais l'origine réelle.
3. **Relais/proxy** (`/api/relay/<token>/<exp>/<blob>`) — vérifie le token,
   applique la limitation de débit, **déchiffre la cible**, va chercher le flux
   amont et le **restreame** au lecteur. Les manifests HLS imbriqués
   (`master.m3u8` → `media.m3u8` → segments `.ts`, clés `#EXT-X-KEY`) sont
   réécrits à la volée ; les segments binaires sont diffusés en flux (avec
   support des requêtes `Range`).

## Techniques mises en œuvre

| Besoin | Implémentation |
| --- | --- |
| **Proxy / restream** | `app/api/relay/**` + `lib/relay.ts` — fetch amont, réécriture HLS, streaming binaire passe-plat |
| **CDN privé** | l'URL d'origine est **chiffrée (AES-256-GCM)** dans le lien relais : le client ne la voit jamais (`lib/crypto.ts`) |
| **Authentification** | clé admin pour l'API de gestion ; clé par playlist (`?key=`) ; liens relais signés/chiffrés liés au token + expiration |
| **Cache** | cache TTL en mémoire avec coalescence des requêtes pour la source et les manifests HLS (`lib/cache.ts`) |
| **Journalisation** | chaque requête playlist/relais est journalisée (IP, statut, octets, latence, cache) — `lib/store.ts` |
| **Limitation de débit** | token bucket par playlist, configurable (`lib/ratelimit.ts`), renvoie `429` + `Retry-After` |

## Démarrage

```bash
npm install
npm run dev          # http://localhost:3000
# ou en production :
npm run build && npm run start
```

Au premier démarrage, si `ADMIN_KEY` n'est pas définie, une clé est **générée
et affichée dans les logs du serveur** (et persistée dans `.data/secrets.json`).
Ouvrez le tableau de bord, collez la clé admin, puis générez vos 10 sorties.

Copiez `.env.example` vers `.env` pour configurer les secrets et le réglage en
production (voir le fichier pour la liste complète).

## API

Toutes les routes de gestion exigent l'en-tête `x-admin-key` (ou
`Authorization: Bearer <clé>`).

| Méthode & route | Rôle |
| --- | --- |
| `POST /api/sources` | `{"url","label?"}` → crée la source + **10** playlists |
| `GET /api/sources` | liste les sources et leurs URLs de sortie |
| `DELETE /api/sources/<id>` | supprime une source et ses sorties |
| `PATCH /api/playlists/<token>` | `{active?, rotateKey?, rateLimitRpm?}` — active/désactive, régénère la clé, ajuste la limite |
| `GET /api/logs?token=&limit=` | journaux récents + statistiques par playlist |
| `GET /api/playlist/<token>.m3u?key=…` | **sortie privée** (playlist réécrite) — publique avec la clé |
| `GET /api/relay/<token>/<exp>/<blob>` | endpoint relais/proxy authentifié |

### Exemple

```bash
# Générer 10 sorties à partir d'une source
curl -X POST http://localhost:3000/api/sources \
  -H "x-admin-key: $ADMIN_KEY" -H 'content-type: application/json' \
  -d '{"url":"http://provider.example/list.m3u","label":"Ma source"}'
# → { "count": 10, "playlists": [ { "url": "http://localhost:3000/api/playlist/<token>.m3u?key=<key>" }, … ] }
```

Collez n'importe laquelle des 10 URLs `…/api/playlist/<token>.m3u?key=…` dans
VLC / un lecteur IPTV : tout le trafic transite par votre relais.

## Notes de déploiement

- Le store, le cache et les compteurs de débit sont **en mémoire** (persistance
  JSON best-effort dans `.data/`). Parfait pour un seul instance. Pour un
  déploiement multi-instances/serverless, remplacez `lib/store.ts`,
  `lib/cache.ts` et `lib/ratelimit.ts` par Redis/Postgres — le reste du code ne
  change pas.
- Les routes relais/playlist sont `runtime = "nodejs"` (crypto natif) et
  `dynamic = "force-dynamic"`.
- **N'enregistrez que des sources que vous êtes autorisé à rediffuser.**

## Architecture des fichiers

```
app/
  page.tsx                              Tableau de bord admin (génération, URLs, logs)
  api/
    sources/route.ts                    POST crée source + 10 sorties · GET liste
    sources/[id]/route.ts               DELETE source
    playlists/[token]/route.ts          PATCH active / rotation clé / débit
    playlist/[token]/route.ts           Sortie M3U privée (réécriture)
    relay/[token]/[...path]/route.ts    Relais/proxy (HLS + binaire)
    logs/route.ts                       Journaux + stats
lib/
  config.ts      Configuration + secrets (env ou générés)
  store.ts       Persistance (sources, playlists, logs, stats)
  crypto.ts      Scellement AES-GCM des cibles relais + comparaisons constantes
  m3u.ts         Parsing/réécriture M3U & HLS
  cache.ts       Cache TTL en mémoire avec coalescence
  ratelimit.ts   Token bucket par playlist
  relay.ts       Logique proxy (fetch amont, réécriture, streaming)
  http.ts        Helpers requête (IP, base URL publique, UA)
  auth.ts        Authentification admin
  runtime.ts     Singletons de cache partagés
```

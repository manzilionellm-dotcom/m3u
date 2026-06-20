# Déploiement sur VPS (Hostinger)

Rend la plateforme accessible publiquement (les 10 M3U marchent depuis n'importe
quel appareil), avec un nom de domaine et HTTPS.

## Prérequis

- Un VPS Ubuntu 22.04 / 24.04 (Hostinger), accès `root` en SSH.
- (Pour HTTPS) un nom de domaine dont l'enregistrement DNS **A** pointe vers
  l'IP du VPS.

## Déploiement en 3 commandes

Connectez-vous au VPS puis lancez :

```bash
ssh root@VOTRE_IP_VPS
```

```bash
# 1) Récupérer le script
curl -fsSL https://raw.githubusercontent.com/manzilionellm-dotcom/m3u/claude/m3u-proxy-relay-auth-l7kmza/deploy/vps-setup.sh -o vps-setup.sh

# 2) Le lancer — choisissez UNE des variantes :

#   a) Test rapide, accessible via http://IP:3000
sudo bash vps-setup.sh

#   b) Avec un domaine en HTTP
sudo bash vps-setup.sh mondomaine.com

#   c) Avec domaine + HTTPS automatique (recommandé)
sudo bash vps-setup.sh mondomaine.com votre@email.com
```

À la fin, le script affiche votre **URL publique** et votre **clé admin**.
Ouvrez l'URL, collez la clé, et générez vos 10 M3U.

## Que fait le script ?

- installe Node.js 20 LTS, git, pm2, (et Nginx + Certbot si domaine) ;
- clone la branche `claude/m3u-proxy-relay-auth-l7kmza`, `npm install`, `npm run build` ;
- génère `ADMIN_KEY` + `RELAY_SECRET` et définit `PUBLIC_BASE_URL` dans `.env` ;
- lance l'app avec **pm2** (redémarrage auto au reboot) ;
- configure Nginx en reverse proxy (streaming sans buffering) + HTTPS via Certbot.

## Mettre à jour plus tard

```bash
sudo bash /opt/m3u/deploy/vps-setup.sh mondomaine.com votre@email.com
```

## Commandes utiles

```bash
pm2 logs m3u       # voir les logs en direct
pm2 restart m3u    # redémarrer
pm2 status         # état de l'app
cat /opt/m3u/.env  # revoir la clé admin
```

#!/usr/bin/env bash
#
# Déploiement tout-en-un de la plateforme M3U sur un VPS Ubuntu/Debian
# (testé pour Hostinger VPS - Ubuntu 22.04 / 24.04).
#
# Usage (en root) :
#   sudo bash vps-setup.sh                      # juste sur le port 3000 (IP:3000)
#   sudo bash vps-setup.sh mondomaine.com       # + Nginx (HTTP)
#   sudo bash vps-setup.sh mondomaine.com you@mail.com   # + Nginx + HTTPS auto
#
# Le script est idempotent : on peut le relancer pour mettre à jour le code.

set -euo pipefail

DOMAIN="${1:-}"
EMAIL="${2:-}"
BRANCH="claude/m3u-proxy-relay-auth-l7kmza"
REPO="https://github.com/manzilionellm-dotcom/m3u.git"
APP_DIR="/opt/m3u"
PORT="3000"

log() { echo -e "\n==> $*"; }

if [ "$(id -u)" -ne 0 ]; then
  echo "Lancez ce script en root (sudo bash vps-setup.sh ...)" >&2
  exit 1
fi

log "Mise à jour des paquets"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl git ca-certificates

log "Installation de Node.js 20 LTS (si absent)"
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
node -v

log "Installation de pm2 (gestionnaire de process)"
npm install -g pm2 >/dev/null 2>&1 || npm install -g pm2

log "Récupération du code (branche $BRANCH)"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" fetch origin "$BRANCH"
  git -C "$APP_DIR" checkout "$BRANCH"
  git -C "$APP_DIR" reset --hard "origin/$BRANCH"
else
  git clone -b "$BRANCH" "$REPO" "$APP_DIR"
fi

cd "$APP_DIR"

log "Installation des dépendances + build production"
npm install
npm run build

log "Configuration des secrets (.env)"
if [ ! -f "$APP_DIR/.env" ]; then
  ADMIN_KEY="$(node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))")"
  RELAY_SECRET="$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")"
  if [ -n "$DOMAIN" ]; then
    BASE_URL="https://$DOMAIN"
  else
    PUBIP="$(curl -fsS https://api.ipify.org || echo "VOTRE_IP")"
    BASE_URL="http://$PUBIP:$PORT"
  fi
  cat > "$APP_DIR/.env" <<EOF
ADMIN_KEY=$ADMIN_KEY
RELAY_SECRET=$RELAY_SECRET
PUBLIC_BASE_URL=$BASE_URL
PORT=$PORT
EOF
  chmod 600 "$APP_DIR/.env"
  echo "Secrets générés dans $APP_DIR/.env"
else
  echo "$APP_DIR/.env existe déjà, on le conserve."
fi

log "Démarrage avec pm2"
set -a; . "$APP_DIR/.env"; set +a
pm2 delete m3u >/dev/null 2>&1 || true
pm2 start npm --name m3u -- run start
pm2 save
pm2 startup systemd -u root --hp /root >/dev/null 2>&1 || true

# Ouvrir le pare-feu si ufw est actif
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  ufw allow 80/tcp >/dev/null 2>&1 || true
  ufw allow 443/tcp >/dev/null 2>&1 || true
  [ -z "$DOMAIN" ] && ufw allow "${PORT}/tcp" >/dev/null 2>&1 || true
fi

# Reverse proxy Nginx + HTTPS
if [ -n "$DOMAIN" ]; then
  log "Configuration de Nginx pour $DOMAIN"
  apt-get install -y nginx
  cat > /etc/nginx/sites-available/m3u <<EOF
server {
    listen 80;
    server_name $DOMAIN;

    # Streaming : pas de mise en mémoire tampon, connexions longues.
    proxy_buffering off;
    proxy_request_buffering off;
    proxy_read_timeout 3600s;
    client_max_body_size 0;

    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header X-Forwarded-Host \$host;
    }
}
EOF
  ln -sf /etc/nginx/sites-available/m3u /etc/nginx/sites-enabled/m3u
  rm -f /etc/nginx/sites-enabled/default
  nginx -t && systemctl reload nginx

  if [ -n "$EMAIL" ]; then
    log "Activation HTTPS via Certbot"
    apt-get install -y certbot python3-certbot-nginx
    if certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$EMAIL" --redirect; then
      echo "HTTPS activé."
    else
      echo "ATTENTION : Certbot a échoué. Vérifiez que le DNS de $DOMAIN pointe bien vers l'IP de ce VPS, puis relancez : certbot --nginx -d $DOMAIN"
    fi
  fi
fi

echo ""
echo "======================================================================"
echo " ✅ Déploiement terminé."
echo ""
grep -E '^(ADMIN_KEY|PUBLIC_BASE_URL)=' "$APP_DIR/.env"
echo ""
echo " Ouvrez l'URL PUBLIC_BASE_URL ci-dessus dans votre navigateur,"
echo " collez la clé ADMIN_KEY dans le tableau de bord, puis générez vos 10 M3U."
echo ""
echo " Commandes utiles :"
echo "   pm2 logs m3u      # voir les logs"
echo "   pm2 restart m3u   # redémarrer"
echo "   sudo bash $APP_DIR/deploy/vps-setup.sh $DOMAIN $EMAIL   # mettre à jour"
echo "======================================================================"

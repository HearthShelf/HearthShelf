#!/bin/sh
# All-in-one entrypoint: run nginx, the bundled AudiobookShelf server, and the
# HearthShelf backend in one container. nginx is the only ingress (port 80); ABS
# listens on 127.0.0.1:13378 and HearthShelf's backend on 127.0.0.1:8080, both
# reached only through nginx. tini (PID 1) reaps children; this script supervises
# them and exits if any one dies, so Docker's restart policy recycles the box.
set -e

# --- hs.direct: obtain a wildcard cert + a synthesized PUBLIC_URL (optional) ---
# When HSDIRECT_ENABLED=true, this generates our own key+CSR, has the VPS broker
# sign it, installs the cert, and EXPORTS a synthesized PUBLIC_URL. It never holds
# our key off-box and never aborts the container on failure. Must run BEFORE the
# envsubst pass so PUBLIC_URL/HSDIRECT_STABLE_HOST are available to the templates.
if [ "${HSDIRECT_ENABLED:-false}" = "true" ]; then
  echo "[aio] hs.direct enabled - acquiring certificate"
  # The cert script exports PUBLIC_URL and writes /config/hsdirect/stable_host.
  . /hs-direct-cert.sh || echo "[aio] hs.direct cert step failed (continuing)"
  if [ -f /config/hsdirect/stable_host ]; then
    HSDIRECT_STABLE_HOST="$(cat /config/hsdirect/stable_host)"
    export HSDIRECT_STABLE_HOST
  fi
  if [ -f /config/hsdirect/public_url ]; then
    PUBLIC_URL="$(cat /config/hsdirect/public_url)"
    export PUBLIC_URL
  fi
fi

# Same envsubst pass as the slim image: bake runtime URLs into the nginx config.
# In aio, ABS_SERVER_URL points at the loopback ABS we start below.
export HS_APP_ORIGIN="${HS_APP_ORIGIN:-https://app.hearthshelf.com}"
envsubst '${ABS_SERVER_URL} ${PUBLIC_URL} ${HS_APP_ORIGIN}' \
  < /etc/nginx/templates/default.conf.template \
  > /etc/nginx/conf.d/default.conf
envsubst '${ABS_SERVER_URL} ${PUBLIC_URL}' \
  < /etc/nginx/templates/abs_proxy.conf.template \
  > /etc/nginx/abs_proxy.conf
cp /etc/nginx/templates/upgrade-map.conf /etc/nginx/conf.d/upgrade-map.conf
envsubst '${HS_APP_ORIGIN}' \
  < /etc/nginx/templates/cors-map.conf.template \
  > /etc/nginx/conf.d/cors-map.conf

# hs.direct :443 server block - only when enabled AND a cert was installed.
if [ "${HSDIRECT_ENABLED:-false}" = "true" ] && [ -f /etc/hsdirect/tls/fullchain.pem ]; then
  echo "[aio] hs.direct: enabling :443 with the provisioned wildcard cert"
  envsubst '${ABS_SERVER_URL} ${PUBLIC_URL} ${HSDIRECT_STABLE_HOST}' \
    < /etc/nginx/templates/hsdirect_abs_proxy.conf.template \
    > /etc/nginx/hsdirect_abs_proxy.conf
  envsubst '${ABS_SERVER_URL} ${HSDIRECT_STABLE_HOST}' \
    < /etc/nginx/templates/hsdirect-ssl.conf.template \
    > /etc/nginx/conf.d/hsdirect-ssl.conf
fi

# --- bundled AudiobookShelf ---
# ABS reads PORT/CONFIG_PATH/METADATA_PATH from the environment. We keep these
# in ABS_*-prefixed vars in the image so they never collide with HearthShelf's
# own config, then map them in just for the ABS process.
echo "[aio] starting AudiobookShelf on :${ABS_PORT}"
(
  cd /abs
  PORT="${ABS_PORT}" \
  CONFIG_PATH="${ABS_CONFIG_PATH}" \
  METADATA_PATH="${ABS_METADATA_PATH}" \
  SOURCE=docker \
  exec node index.js
) &
ABS_PID=$!

# --- HearthShelf backend ---
echo "[aio] starting HearthShelf backend on :8080"
QG_PORT=8080 node /app/server/index.js &
HS_PID=$!

# --- nginx ---
echo "[aio] starting nginx on :80"
nginx -g 'daemon off;' &
NGINX_PID=$!

# Supervise: if any process exits, stop the others and exit non-zero so Docker
# restarts the whole container (simplest correct behavior for a single-box app).
# `wait -n` isn't reliable in busybox ash, so poll each PID with `kill -0`.
term() {
  kill "$ABS_PID" "$HS_PID" "$NGINX_PID" 2>/dev/null || true
  wait 2>/dev/null || true
}
trap 'term; exit 0' TERM INT

while kill -0 "$ABS_PID" 2>/dev/null \
   && kill -0 "$HS_PID" 2>/dev/null \
   && kill -0 "$NGINX_PID" 2>/dev/null; do
  sleep 2
done

echo "[aio] a supervised process exited; shutting down container"
term
exit 1

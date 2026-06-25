#!/bin/sh
# All-in-one entrypoint: run nginx, the bundled AudiobookShelf server, and the
# HearthShelf backend in one container. nginx is the only ingress (port 80); ABS
# listens on 127.0.0.1:13378 and HearthShelf's backend on 127.0.0.1:8080, both
# reached only through nginx. tini (PID 1) reaps children; this script supervises
# them and exits if any one dies, so Docker's restart policy recycles the box.
set -e

# --- hs.direct: pick up a previously provisioned cert + public URL ------------
# hs.direct cert ACQUISITION lives in the HearthShelf backend now (it runs at the
# pairing moment and on boot, because the control-plane credentials only exist
# after pairing - see server/lib/hsdirect.js). Here we just consume what the
# backend persisted on a prior run: if a cert + stable host already exist, use the
# synthesized PUBLIC_URL and enable the :443 block below. A freshly-paired box
# gets its cert from the backend within seconds and serves :443 after the backend
# reloads nginx (or on the next restart). No env var required - it just works once
# paired, unless the admin set HSDIRECT_DISABLED.
if [ -f /config/hsdirect/stable_host ]; then
  HSDIRECT_STABLE_HOST="$(cat /config/hsdirect/stable_host)"
  export HSDIRECT_STABLE_HOST
fi
# Only let hs.direct drive PUBLIC_URL when the admin hasn't set their own. Their
# own domain is preferred; hs.direct stays the monitored fallback (see the
# control-plane fallback logic). If PUBLIC_URL is unset, use the hs.direct one.
if [ -z "${PUBLIC_URL:-}" ] && [ -f /config/hsdirect/public_url ]; then
  PUBLIC_URL="$(cat /config/hsdirect/public_url)"
  export PUBLIC_URL
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

# hs.direct :443 server block - whenever a provisioned cert + stable host exist.
# No env gate: the backend only writes these once the box is paired and not opted
# out, so their presence IS the signal to serve HTTPS.
if [ -f /etc/hsdirect/tls/fullchain.pem ] && [ -n "${HSDIRECT_STABLE_HOST:-}" ]; then
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

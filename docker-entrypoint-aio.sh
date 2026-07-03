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

# Shared bits both the HTTP and HTTPS server blocks include.
export HS_APP_ORIGIN="${HS_APP_ORIGIN:-https://app.hearthshelf.com}"
envsubst '${ABS_SERVER_URL} ${PUBLIC_URL}' \
  < /etc/nginx/templates/abs_proxy.conf.template \
  > /etc/nginx/abs_proxy.conf
cp /etc/nginx/templates/upgrade-map.conf /etc/nginx/conf.d/upgrade-map.conf
envsubst '${HS_APP_ORIGIN}' \
  < /etc/nginx/templates/cors-map.conf.template \
  > /etc/nginx/conf.d/cors-map.conf

# SINGLE-PORT model (Plex-style): the container listens on ONE port (:80, mapped
# to the host's WebUI port, e.g. 9277). Before a cert exists we serve plain HTTP
# there for LAN access. Once hs.direct has provisioned a cert, a stream TLS-detect
# demux serves BOTH plain-HTTP LAN access AND connect-domain HTTPS on that same
# port. The render decision lives in render-hsdirect.sh so the backend can re-run
# the SAME logic when a cert lands at pairing time and reload nginx.
/usr/local/bin/render-hsdirect.sh
# Safety net: if the rendered config is somehow invalid, fall back to plain HTTP so
# the box ALWAYS comes up with LAN access rather than nginx refusing to start. The
# cert-present render is validated at build time, so this should never trigger.
if ! nginx -t >/dev/null 2>&1; then
  echo "[aio] WARNING: rendered nginx config failed validation - falling back to plain HTTP for LAN access"
  cp /etc/nginx/nginx.conf.stock /etc/nginx/nginx.conf
  envsubst '${ABS_SERVER_URL} ${PUBLIC_URL} ${HS_APP_ORIGIN}' \
    < /etc/nginx/templates/default.conf.template \
    > /etc/nginx/conf.d/default.conf
  rm -f /etc/nginx/conf.d/hsdirect-ssl.conf /etc/nginx/hsdirect-http.conf /etc/nginx/hsdirect-ssl.conf
fi

# --- bundled AudiobookShelf ---
# ABS reads PORT/CONFIG_PATH/METADATA_PATH from the environment. We keep these
# in ABS_*-prefixed vars in the image so they never collide with HearthShelf's
# own config, then map them in just for the ABS process.
#
# ROUTER_BASE_PATH="" runs ABS at the origin ROOT instead of its /audiobookshelf
# default. nginx already proxies ABS at root (/api, /auth, /socket.io ... with no
# /audiobookshelf prefix), so this aligns ABS's router mount with how we proxy it.
# It also makes ABS's OIDC web-callback validator (isValidWebCallbackUrl) accept a
# relative callback like /hs/hosted/connect-return: that check requires the
# callback path to start with RouterBasePath, and /audiobookshelf would reject our
# HearthShelf-served relay path. Empty base path -> the check is just startsWith('/').
echo "[aio] starting AudiobookShelf on :${ABS_PORT} (root base path)"
(
  cd /abs
  PORT="${ABS_PORT}" \
  CONFIG_PATH="${ABS_CONFIG_PATH}" \
  METADATA_PATH="${ABS_METADATA_PATH}" \
  ROUTER_BASE_PATH="" \
  SOURCE=docker \
  exec node index.js
) &
ABS_PID=$!

# --- HearthShelf backend ---
# node26: the pinned Node 26 (Dockerfile lifts it from the builder). The backend
# imports @hearthshelf/core's .ts at runtime and needs Node's native TS strip
# (>=23.6); ABS above keeps Alpine's `node`.
echo "[aio] starting HearthShelf backend on :8080"
QG_PORT=8080 node26 /app/server/index.js &
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

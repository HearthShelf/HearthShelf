#!/bin/sh
# All-in-one entrypoint: run nginx, the bundled AudiobookShelf server, and the
# HearthShelf backend in one container. nginx is the only ingress (port 80); ABS
# listens on 127.0.0.1:13378 and HearthShelf's backend on 127.0.0.1:8080, both
# reached only through nginx. tini (PID 1) reaps children; this script supervises
# them and exits if any one dies, so Docker's restart policy recycles the box.
set -e

# Same envsubst pass as the slim image: bake runtime URLs into the nginx config.
# In aio, ABS_SERVER_URL points at the loopback ABS we start below.
envsubst '${ABS_SERVER_URL} ${PUBLIC_URL}' \
  < /etc/nginx/templates/default.conf.template \
  > /etc/nginx/conf.d/default.conf
envsubst '${ABS_SERVER_URL} ${PUBLIC_URL}' \
  < /etc/nginx/templates/abs_proxy.conf.template \
  > /etc/nginx/abs_proxy.conf
cp /etc/nginx/templates/upgrade-map.conf /etc/nginx/conf.d/upgrade-map.conf

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

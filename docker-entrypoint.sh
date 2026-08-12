#!/bin/sh
set -e

# Substitute runtime config into the server block and the shared proxy snippet.
# Only the listed vars are replaced; nginx's own $variables are left intact.
# HS_APP_ORIGIN (the hosted SPA origin) drives cross-origin CORS on the ABS
# locations; empty in self-hosted mode, which disables those CORS headers.
export HS_APP_ORIGIN="${HS_APP_ORIGIN:-https://app.hearthshelf.com}"

# Hostname (no scheme, no port, no path) from ABS_SERVER_URL, used as the SNI
# name on upstream TLS. Without it nginx sends no SNI and any ABS behind a
# cert-by-SNI host (Cloudflare, most reverse proxies) 502s the whole app.
ABS_SERVER_HOST="$(printf '%s' "${ABS_SERVER_URL}" | sed -e 's#^[a-z]*://##' -e 's#/.*$##' -e 's#:[0-9]*$##')"
export ABS_SERVER_HOST

envsubst '${ABS_SERVER_URL} ${PUBLIC_URL} ${HS_APP_ORIGIN}' \
  < /etc/nginx/templates/default.conf.template \
  > /etc/nginx/conf.d/default.conf

envsubst '${ABS_SERVER_URL} ${PUBLIC_URL} ${ABS_SERVER_HOST}' \
  < /etc/nginx/templates/abs_proxy.conf.template \
  > /etc/nginx/abs_proxy.conf

# Static http-scope map (no substitution needed).
cp /etc/nginx/templates/upgrade-map.conf /etc/nginx/conf.d/upgrade-map.conf

# CORS origin map (http scope): substitute the allowed hosted SPA origin.
envsubst '${HS_APP_ORIGIN}' \
  < /etc/nginx/templates/cors-map.conf.template \
  > /etc/nginx/conf.d/cors-map.conf

# Start the HearthShelf backend in the background. It reads its provider key,
# rate limit, and ABS_SERVER_URL from the environment. nginx proxies /hs/* to it
# on localhost:8080. If it exits, nginx still serves the SPA (the client falls
# back to the heuristic recommender when /hs is unreachable).
if [ -f /app/server/index.js ]; then
  QG_PORT=8080 node /app/server/index.js &
fi

exec "$@"

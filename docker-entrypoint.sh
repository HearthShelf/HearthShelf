#!/bin/sh
set -e

# Substitute runtime config into the server block and the shared proxy snippet.
# Only the listed vars are replaced; nginx's own $variables are left intact.
# HS_APP_ORIGIN (the hosted SPA origin) drives cross-origin CORS on the ABS
# locations; empty in self-hosted mode, which disables those CORS headers.
export HS_APP_ORIGIN="${HS_APP_ORIGIN:-https://app.hearthshelf.com}"

# Normalize ABS_SERVER_URL: strip any trailing slash BEFORE anything reads it.
# A trailing slash renders as `proxy_pass http://host:port/;` - and a proxy_pass
# with a URI part is illegal inside a regex location, so nginx refuses to start
# ("proxy_pass cannot have URI part in location given by regular expression")
# and the container never comes up. Doing it here also normalizes the value for
# the backend below, which inherits this environment.
while [ "${ABS_SERVER_URL}" != "${ABS_SERVER_URL%/}" ]; do
  ABS_SERVER_URL="${ABS_SERVER_URL%/}"
done
export ABS_SERVER_URL

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

# CORS origin map must exist before the validation below (default.conf includes it).
envsubst '${HS_APP_ORIGIN}' \
  < /etc/nginx/templates/cors-map.conf.template \
  > /etc/nginx/conf.d/cors-map.conf

# Validate before handing off to nginx. Without this, a bad ABS_SERVER_URL makes
# nginx die with a bare [emerg] and the container restart-loops with no hint at
# what to change. Print the offending value and the likely cause instead.
if ! nginx -t >/dev/null 2>&1; then
  echo "[hearthshelf] ERROR: generated nginx config is invalid."
  echo "[hearthshelf] ABS_SERVER_URL=${ABS_SERVER_URL}"
  echo "[hearthshelf] Expected an origin only, e.g. http://192.168.1.5:13378"
  echo "[hearthshelf] - no trailing slash, no path, no quotes."
  nginx -t 2>&1 | sed 's/^/[hearthshelf]   /'
  exit 1
fi

# Start the HearthShelf backend in the background. It reads its provider key,
# rate limit, and ABS_SERVER_URL from the environment. nginx proxies /hs/* to it
# on localhost:8080. If it exits, nginx still serves the SPA (the client falls
# back to the heuristic recommender when /hs is unreachable).
if [ -f /app/server/index.js ]; then
  QG_PORT=8080 node /app/server/index.js &
fi

exec "$@"

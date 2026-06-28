#!/bin/sh
# Render the AIO nginx server block for the WebUI port, picking HTTP or HTTPS
# based on whether hs.direct has provisioned a cert. SINGLE source of truth for
# that decision, called from TWO places:
#   - docker-entrypoint-aio.sh, at container start.
#   - server/lib/hsdirect.js (reloadNginx), right after a cert lands at pairing
#     time - so the box flips HTTP->HTTPS without waiting for a restart.
#
# `nginx -s reload` only re-reads the files already on disk; it does NOT re-run
# the entrypoint. So the cert-landing reload MUST re-render first, or nginx keeps
# serving the plain-HTTP default.conf and every TLS handshake fails (400 ->
# ERR_SSL_PROTOCOL_ERROR). This script does that render; the caller reloads.
#
# Inputs (env): ABS_SERVER_URL, PUBLIC_URL, HS_APP_ORIGIN. HSDIRECT_STABLE_HOST
# is read from /config/hsdirect/stable_host; HSDIRECT_PUBLIC_HOST (host:port) is
# derived from /config/hsdirect/public_url.
set -e

if [ -f /config/hsdirect/stable_host ]; then
  HSDIRECT_STABLE_HOST="$(cat /config/hsdirect/stable_host)"
  export HSDIRECT_STABLE_HOST
fi

# The host:port the BROWSER actually uses (e.g. <ip-dashed>.<hash>.<zone>:9277),
# parsed from the persisted public_url. ABS must see THIS as its Host so the OIDC
# redirect_uri it sends to Clerk is the reachable address (Clerk redirects the
# browser there). The portless stable host is cert-valid but not browser-reachable.
if [ -f /config/hsdirect/public_url ]; then
  # strip scheme, then strip everything from the first '/' onward -> host[:port]
  HSDIRECT_PUBLIC_HOST="$(sed -e 's#^[a-z]*://##' -e 's#/.*$##' /config/hsdirect/public_url)"
  export HSDIRECT_PUBLIC_HOST
fi

export HS_APP_ORIGIN="${HS_APP_ORIGIN:-https://app.hearthshelf.com}"

if [ -f /config/hsdirect/tls/fullchain.pem ] && [ -n "${HSDIRECT_STABLE_HOST:-}" ] && [ -n "${HSDIRECT_PUBLIC_HOST:-}" ]; then
  # CERT PRESENT: serve BOTH protocols on the one port via a stream TLS-detect
  # demux (Plex-style). plain HTTP -> LAN server (:8081); TLS -> connect-domain
  # HTTPS server (:8443). This keeps LAN/direct-IP access working AND serves the
  # connect-domain cert, on the single host-mapped port.
  echo "[render-hsdirect] cert present: TLS-demux on the WebUI port (LAN HTTP + connect HTTPS, ABS host=${HSDIRECT_PUBLIC_HOST})"

  # Shared ABS proxy fragment, Host forced to the reachable public host:port.
  envsubst '${ABS_SERVER_URL} ${PUBLIC_URL} ${HSDIRECT_PUBLIC_HOST}' \
    < /etc/nginx/templates/hsdirect_abs_proxy.conf.template \
    > /etc/nginx/hsdirect_abs_proxy.conf

  # Internal LAN HTTP server (:8081) and connect-domain HTTPS server (:8443).
  envsubst '${ABS_SERVER_URL}' \
    < /etc/nginx/templates/hsdirect-http.conf.template \
    > /etc/nginx/hsdirect-http.conf
  envsubst '${ABS_SERVER_URL} ${HSDIRECT_PUBLIC_HOST}' \
    < /etc/nginx/templates/hsdirect-ssl.conf.template \
    > /etc/nginx/hsdirect-ssl.conf

  # Swap in the top-level nginx.conf that adds the stream{} demux. Remove the
  # conf.d server block so the base http{} glob doesn't also bind :80.
  cp /etc/nginx/templates/aio-nginx.conf.template /etc/nginx/nginx.conf
  rm -f /etc/nginx/conf.d/default.conf /etc/nginx/conf.d/hsdirect-ssl.conf
else
  echo "[render-hsdirect] no cert yet: plain HTTP on the WebUI port"
  # Restore the stock top-level nginx.conf (saved at build time) and serve the
  # plain HTTP server block on :80 directly (no demux needed without a cert).
  cp /etc/nginx/nginx.conf.stock /etc/nginx/nginx.conf
  envsubst '${ABS_SERVER_URL} ${PUBLIC_URL} ${HS_APP_ORIGIN}' \
    < /etc/nginx/templates/default.conf.template \
    > /etc/nginx/conf.d/default.conf
  rm -f /etc/nginx/conf.d/hsdirect-ssl.conf /etc/nginx/hsdirect-http.conf /etc/nginx/hsdirect-ssl.conf
fi

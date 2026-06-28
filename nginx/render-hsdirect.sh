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
# is read from /config/hsdirect/stable_host if present.
set -e

if [ -f /config/hsdirect/stable_host ]; then
  HSDIRECT_STABLE_HOST="$(cat /config/hsdirect/stable_host)"
  export HSDIRECT_STABLE_HOST
fi

export HS_APP_ORIGIN="${HS_APP_ORIGIN:-https://app.hearthshelf.com}"

if [ -f /etc/hsdirect/tls/fullchain.pem ] && [ -n "${HSDIRECT_STABLE_HOST:-}" ]; then
  echo "[render-hsdirect] serving HTTPS on the WebUI port with the provisioned cert"
  envsubst '${ABS_SERVER_URL} ${PUBLIC_URL} ${HSDIRECT_STABLE_HOST}' \
    < /etc/nginx/templates/hsdirect_abs_proxy.conf.template \
    > /etc/nginx/hsdirect_abs_proxy.conf
  # The SSL block listens on :80 ssl - it REPLACES the plain :80 block (we don't
  # render default.conf), so there's exactly one server on the port.
  envsubst '${ABS_SERVER_URL} ${HSDIRECT_STABLE_HOST}' \
    < /etc/nginx/templates/hsdirect-ssl.conf.template \
    > /etc/nginx/conf.d/hsdirect-ssl.conf
  rm -f /etc/nginx/conf.d/default.conf
else
  echo "[render-hsdirect] no cert yet: serving plain HTTP on the WebUI port"
  envsubst '${ABS_SERVER_URL} ${PUBLIC_URL} ${HS_APP_ORIGIN}' \
    < /etc/nginx/templates/default.conf.template \
    > /etc/nginx/conf.d/default.conf
  rm -f /etc/nginx/conf.d/hsdirect-ssl.conf
fi

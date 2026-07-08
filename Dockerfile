# HearthShelf ships as two images from this one Dockerfile:
#
#   slim (default) - HearthShelf only. The admin points it at their own ABS
#       server via ABS_SERVER_URL. This is the original image, unchanged.
#         docker build --target slim -t hearthshelf:slim .
#
#   aio - all-in-one. The official AudiobookShelf server is bundled in the same
#       container; HearthShelf provisions and fronts it, owning the whole setup
#       and onboarding flow. One container, one `docker run`.
#         docker build --target aio -t hearthshelf:aio .
#
# Both share the SPA build and the QuestGiver backend; only the final stage and
# entrypoint differ.

# --- Shared build stages ---------------------------------------------------

FROM node:26-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build
# Compile @hearthshelf/core to dist JS for the no-bundler server. The SPA build
# above reads core's .ts via its alias; the server imports the compiled output.
RUN npx tsc -p packages/core/tsconfig.build.json

# Install the backend's production deps (libSQL + the file: @hearthshelf/core) in
# the same Alpine/Node base as the runtime, so the native binding matches the
# target platform. Needs the built core tree present for the file: dependency.
FROM node:26-alpine AS server-deps
WORKDIR /app
COPY --from=builder /app/packages/core /app/packages/core
WORKDIR /app/server
COPY server/package*.json ./
RUN npm ci --omit=dev

# Pull the official ABS image so the aio stage can copy its runtime out of it.
# Pinned by the same tag self-hosters would run; bump deliberately.
FROM ghcr.io/advplyr/audiobookshelf:latest AS abs

# --- slim: HearthShelf only (default target) -------------------------------

FROM nginx:alpine AS slim
# Node runtime for the QuestGiver backend service (the only server beyond nginx).
# The backend imports @hearthshelf/core as COMPILED dist JS (built in the builder
# stage), so Alpine's stock nodejs is fine - no runtime TypeScript, no Node major
# floor.
RUN apk add --no-cache nodejs

COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx/default.conf /etc/nginx/templates/default.conf.template
COPY nginx/abs_proxy.conf /etc/nginx/templates/abs_proxy.conf.template
COPY nginx/upgrade-map.conf /etc/nginx/templates/upgrade-map.conf
COPY nginx/cors-map.conf /etc/nginx/templates/cors-map.conf.template
COPY nginx/cors-headers.conf /etc/nginx/cors-headers.conf
# QuestGiver backend + its node_modules (libSQL driver + the @hearthshelf/core
# file: dep, which resolves to the compiled dist for the Auto queue compute).
COPY --from=builder /app/packages/core /app/packages/core
COPY server/ /app/server/
COPY --from=server-deps /app/server/node_modules /app/server/node_modules
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh
EXPOSE 80
ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["nginx", "-g", "daemon off;"]

# --- aio: HearthShelf + bundled AudiobookShelf -----------------------------

FROM nginx:alpine AS aio
# nodejs runs both the QuestGiver backend and the bundled ABS server; ffmpeg +
# tini are ABS runtime requirements (transcoding, PID 1 reaping).
# openssl: the backend uses it to generate the hs.direct keypair + CSR at pairing
# (the private key never leaves the container). nginx/node/ffmpeg/tini as before.
# The stream module (incl. ssl_preread) is compiled INTO nginx.org's official
# nginx alpine package (--with-stream), so the :80 TLS-detect demux needs no extra
# package and no load_module. (There is no separate nginx-module-stream package on
# nginx.org's repo; stream is statically built in.)
# Alpine's `nodejs` runs both the bundled ABS and the QuestGiver backend - the
# backend imports @hearthshelf/core as COMPILED dist JS (built in the builder),
# so no newer Node is required.
RUN apk add --no-cache nodejs ffmpeg tini tzdata openssl

# HearthShelf SPA + backend (same as slim).
COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx/default.conf /etc/nginx/templates/default.conf.template
COPY nginx/abs_proxy.conf /etc/nginx/templates/abs_proxy.conf.template
COPY nginx/upgrade-map.conf /etc/nginx/templates/upgrade-map.conf
COPY nginx/cors-map.conf /etc/nginx/templates/cors-map.conf.template
COPY nginx/cors-headers.conf /etc/nginx/cors-headers.conf
# hs.direct automatic HTTPS: the :443 nginx templates. Cert acquisition itself is
# done by the HearthShelf backend (server/lib/hsdirect.js) at pairing time, since
# the control-plane credentials only exist after pairing. The entrypoint enables
# the :443 block once the backend has provisioned a cert. openssl is needed by the
# backend to generate the box's keypair + CSR (its private key never leaves here).
COPY nginx/hsdirect-ssl.conf.template /etc/nginx/templates/hsdirect-ssl.conf.template
COPY nginx/hsdirect-http.conf.template /etc/nginx/templates/hsdirect-http.conf.template
COPY nginx/hsdirect_abs_proxy.conf.template /etc/nginx/templates/hsdirect_abs_proxy.conf.template
# Top-level nginx.conf used when a cert exists: adds a stream{} TLS-detect demux so
# the one host port serves BOTH plain-HTTP LAN access and connect-domain HTTPS.
# Save the stock nginx.conf so render-hsdirect.sh can restore it in the no-cert state.
COPY nginx/aio-nginx.conf.template /etc/nginx/templates/aio-nginx.conf.template
RUN cp /etc/nginx/nginx.conf /etc/nginx/nginx.conf.stock
# @hearthshelf/core built to dist (the server's file: dep resolves to it), then
# the backend + its node_modules.
COPY --from=builder /app/packages/core /app/packages/core
COPY server/ /app/server/
COPY --from=server-deps /app/server/node_modules /app/server/node_modules

# Bundled AudiobookShelf: its app tree and the nunicode sqlite extension it
# loads at runtime, copied straight out of the official image.
COPY --from=abs /app /abs
COPY --from=abs /usr/local/lib/nusqlite3 /usr/local/lib/nusqlite3

# ABS runtime config. It listens on an in-container port only (nginx is the sole
# ingress on 80); config + metadata live on the data volume.
ENV ABS_PORT=13378 \
    ABS_CONFIG_PATH=/config \
    ABS_METADATA_PATH=/metadata \
    NUSQLITE3_DIR=/usr/local/lib/nusqlite3 \
    NUSQLITE3_PATH=/usr/local/lib/nusqlite3/libnusqlite3.so \
    HS_MODE=aio \
    ABS_SERVER_URL=http://127.0.0.1:13378

# Shared nginx render step (HTTP vs HTTPS for the WebUI port). The entrypoint runs
# it at start; the backend runs it when a cert lands at pairing time, then reloads.
COPY nginx/render-hsdirect.sh /usr/local/bin/render-hsdirect.sh
RUN chmod +x /usr/local/bin/render-hsdirect.sh

# The stock nginx:alpine image symlinks access.log/error.log to /dev/stdout/stderr,
# which are themselves symlinks to /proc/self/fd/1|2 - a Docker container's stdio
# pipes. `nginx -t` opens these paths for real (not just a syntax check), and a
# fresh /proc/self/fd/N open() against a PIPE (rather than a regular file or true
# device) can fail with ENXIO depending on the read end's state - this hit us in
# production, deterministically failing the reload that swaps in a fresh connect-
# domain cert after pairing (server/lib/hsdirect.js calls `nginx -t` from Node).
# Point both logs at plain files instead so nginx never touches a pipe-backed path.
# `docker logs` no longer shows nginx's own access/error lines; see docs/docker-images.md
# for how to read them from the volume-backed log files.
RUN rm -f /var/log/nginx/access.log /var/log/nginx/error.log && \
    touch /var/log/nginx/access.log /var/log/nginx/error.log

# Validate the cert-present demux config AT BUILD TIME so a structural error fails
# the image build (caught in CI) instead of bricking a running box. We render the
# templates with a fake cert + sample host, run `nginx -t`, then clean up.
RUN set -e; \
    export ABS_SERVER_URL=http://127.0.0.1:13378 \
           PUBLIC_URL=https://1-2-3-4.deadbeef.d.hearthshelf.com:9277 \
           HSDIRECT_PUBLIC_HOST=1-2-3-4.deadbeef.d.hearthshelf.com:9277 \
           HS_APP_ORIGIN=https://app.hearthshelf.com; \
    mkdir -p /config/hsdirect/tls; \
    openssl req -x509 -newkey rsa:2048 -nodes -keyout /config/hsdirect/tls/server.key \
      -out /config/hsdirect/tls/fullchain.pem -days 1 -subj "/CN=test" >/dev/null 2>&1; \
    envsubst '${HS_APP_ORIGIN}' < /etc/nginx/templates/cors-map.conf.template > /etc/nginx/conf.d/cors-map.conf; \
    cp /etc/nginx/templates/upgrade-map.conf /etc/nginx/conf.d/upgrade-map.conf; \
    envsubst '${ABS_SERVER_URL} ${PUBLIC_URL}' < /etc/nginx/templates/abs_proxy.conf.template > /etc/nginx/abs_proxy.conf; \
    envsubst '${ABS_SERVER_URL} ${PUBLIC_URL} ${HSDIRECT_PUBLIC_HOST}' < /etc/nginx/templates/hsdirect_abs_proxy.conf.template > /etc/nginx/hsdirect_abs_proxy.conf; \
    envsubst '${ABS_SERVER_URL}' < /etc/nginx/templates/hsdirect-http.conf.template > /etc/nginx/hsdirect-http.conf; \
    envsubst '${ABS_SERVER_URL} ${HSDIRECT_PUBLIC_HOST}' < /etc/nginx/templates/hsdirect-ssl.conf.template > /etc/nginx/hsdirect-ssl.conf; \
    cp /etc/nginx/templates/aio-nginx.conf.template /etc/nginx/nginx.conf; \
    rm -f /etc/nginx/conf.d/default.conf; \
    nginx -t; \
    cp /etc/nginx/nginx.conf.stock /etc/nginx/nginx.conf; \
    rm -rf /config/hsdirect /etc/nginx/hsdirect-http.conf /etc/nginx/hsdirect-ssl.conf /etc/nginx/hsdirect_abs_proxy.conf \
           /etc/nginx/abs_proxy.conf /etc/nginx/conf.d/cors-map.conf /etc/nginx/conf.d/upgrade-map.conf

COPY docker-entrypoint-aio.sh /docker-entrypoint-aio.sh
RUN chmod +x /docker-entrypoint-aio.sh
# Single ingress port :80 - before a cert, plain HTTP. After hs.direct provisions
# a cert, a stream TLS-detect demux serves BOTH plain-HTTP LAN access AND
# connect-domain HTTPS on this same port (Plex-style; we don't take over 443).
EXPOSE 80
# tini as PID 1 reaps the node + nginx children the entrypoint spawns.
ENTRYPOINT ["tini", "--", "/docker-entrypoint-aio.sh"]

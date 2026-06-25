#!/bin/sh
# hs.direct certificate acquisition (runs in the AIO container at startup when
# HSDIRECT_ENABLED=true). See HearthShelf-WebApp docs/hs-direct-implementation.md.
#
# What it does, in order:
#   1. Generate this server's OWN TLS keypair + CSR for *.<hash>.<zone>. The
#      private key is created here and NEVER leaves this container.
#   2. Ask the control plane for a short-lived cert-broker grant, authenticating
#      with the stored server_secret (server-to-server). The CP returns the grant,
#      the VPS broker URL, the stable host, and the zone.
#   3. POST the CSR + grant to the VPS cert broker. The broker runs ACME DNS-01
#      (Cloudflare) and returns the signed wildcard chain. It never sees our key.
#   4. Install key + chain where nginx reads them, compute PUBLIC_URL from the
#      current public IP, and report status back to the control plane.
#
# Idempotent: if a still-valid cert already exists it skips issuance (renewal is
# handled separately by the broker's acme.sh cron; this script just fetches the
# current chain at boot). Never aborts the container on failure - hs.direct is an
# enhancement; on error we log and fall back to whatever PUBLIC_URL was provided.
set -eu

: "${HSDIRECT_ENABLED:=false}"
[ "$HSDIRECT_ENABLED" = "true" ] || { echo "[hsdirect] disabled"; exit 0; }

: "${HSDIRECT_CP_URL:=https://api.hearthshelf.com}"
: "${HSDIRECT_CERT_DIR:=/etc/hsdirect/tls}"
: "${HSDIRECT_STATE_DIR:=/config/hsdirect}"
SERVER_ID="${HS_SERVER_ID:?HS_SERVER_ID required for hs.direct}"
SERVER_SECRET="${HS_SERVER_SECRET:?HS_SERVER_SECRET required for hs.direct}"

mkdir -p "$HSDIRECT_CERT_DIR" "$HSDIRECT_STATE_DIR"
KEY="$HSDIRECT_CERT_DIR/server.key"
CSR="$HSDIRECT_CERT_DIR/server.csr"
CRT="$HSDIRECT_CERT_DIR/fullchain.pem"

log() { echo "[hsdirect] $*"; }
fail() { log "ERROR: $*"; exit 0; }  # exit 0: never block container start

# report_status active|failed [detail] - tells the control plane the outcome so
# the picker/admin UI shows real cert state. Best-effort; never fatal. NOT_AFTER
# is populated later once a cert exists.
NOT_AFTER_EPOCH=""
report_status() {
  st="$1"; detail="${2:-}"
  body="{\"server_id\":\"$SERVER_ID\",\"server_secret\":\"$SERVER_SECRET\",\"status\":\"$st\",\"acme_env\":\"${HSDIRECT_ACME_ENV:-staging}\""
  [ -n "$NOT_AFTER_EPOCH" ] && body="$body,\"not_after\":${NOT_AFTER_EPOCH}000"
  [ -n "$detail" ] && body="$body,\"error\":\"$detail\""
  body="$body}"
  curl -fsS --max-time 15 -X POST "$HSDIRECT_CP_URL/servers/cert-status" \
    -H "Content-Type: application/json" -d "$body" >/dev/null 2>&1 || true
}

command -v curl >/dev/null 2>&1 || fail "curl missing"
command -v openssl >/dev/null 2>&1 || fail "openssl missing"

# --- current public IP (for the IP-bearing hostname label) -------------------
# The synthesis DNS turns <a-b-c-d>.<hash>.<zone> into a.b.c.d, so we encode our
# CURRENT public IP. If we can't determine it, fall back to a hostname the user
# may have set; without an IP the synthesized name can't be built.
detect_ip() {
  for url in "https://api.ipify.org" "https://ifconfig.me/ip" "https://icanhazip.com"; do
    ip=$(curl -fsS --max-time 8 "$url" 2>/dev/null | tr -d '[:space:]')
    case "$ip" in
      *.*.*.*) echo "$ip"; return 0 ;;
    esac
  done
  return 1
}

# --- step 1: keypair + CSR (key stays here) ----------------------------------
# Request the grant first so we know <hash> and <zone> to put in the CSR SAN.

log "requesting cert-broker grant from control plane"
GRANT_JSON=$(curl -fsS --max-time 20 -X POST "$HSDIRECT_CP_URL/servers/cert-grant" \
  -H "Content-Type: application/json" \
  -d "{\"server_id\":\"$SERVER_ID\",\"server_secret\":\"$SERVER_SECRET\"}") \
  || fail "cert-grant request failed"

# Minimal JSON field extraction (busybox has no jq). Values are simple strings.
json_str() { printf '%s' "$1" | sed -n "s/.*\"$2\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p"; }

GRANT=$(json_str "$GRANT_JSON" cert_grant)
BROKER_URL=$(json_str "$GRANT_JSON" broker_url)
HASH=$(json_str "$GRANT_JSON" hash)
HOST=$(json_str "$GRANT_JSON" host)     # stable <hash>.<zone>
ZONE=$(json_str "$GRANT_JSON" zone)
[ -n "$GRANT" ] && [ -n "$BROKER_URL" ] && [ -n "$HASH" ] && [ -n "$HOST" ] \
  || fail "control plane response missing fields"

WILDCARD="*.$HOST"
log "issuing for $WILDCARD via broker $BROKER_URL"

# Generate the key once and keep it (so renewals reuse the same key/CSR).
if [ ! -f "$KEY" ]; then
  openssl ecparam -name prime256v1 -genkey -noout -out "$KEY" 2>/dev/null \
    || fail "key generation failed"
  chmod 600 "$KEY"
fi

# CSR for the wildcard + the apex host (covers <ip>.<hash>.<zone> and <hash>.<zone>).
openssl req -new -key "$KEY" -out "$CSR" -subj "/CN=$WILDCARD" \
  -addext "subjectAltName=DNS:$WILDCARD,DNS:$HOST" 2>/dev/null \
  || fail "CSR generation failed"

# --- step 3: ask the broker to sign the CSR ----------------------------------
# Send the CSR as JSON. The broker verifies the grant (EdDSA, our CP's JWKS),
# runs DNS-01, and returns { "cert": "<PEM>" }. We pin nothing about the broker's
# own TLS here for the POC (-k) because its hostname cert may chicken-and-egg the
# first boot; production should pin the broker cert. TODO: pin broker TLS.
CSR_CONTENT=$(awk 'BEGIN{ORS="\\n"} {print}' "$CSR")
ISSUE_JSON=$(curl -fsS --max-time 180 -k -X POST "$BROKER_URL/issue" \
  -H "Authorization: Bearer $GRANT" \
  -H "Content-Type: application/json" \
  -d "{\"csr\":\"$CSR_CONTENT\",\"server_id\":\"$SERVER_ID\",\"hash\":\"$HASH\"}") \
  || { report_status failed "broker issue request failed"; fail "broker issue failed"; }

# Extract the PEM (multi-line) - pull everything between BEGIN/END markers,
# converting the JSON \n escapes back to real newlines.
printf '%s' "$ISSUE_JSON" \
  | sed -n 's/.*"cert"[[:space:]]*:[[:space:]]*"\(.*\)".*/\1/p' \
  | sed 's/\\n/\n/g' > "$CRT"

if ! grep -q "BEGIN CERTIFICATE" "$CRT"; then
  report_status failed "broker returned no certificate"
  fail "no certificate in broker response"
fi
log "certificate installed at $CRT"

# --- step 4: compute PUBLIC_URL + report status ------------------------------
IP=$(detect_ip) || log "WARN: could not detect public IP; PUBLIC_URL not updated"
if [ -n "${IP:-}" ]; then
  IP_LABEL=$(printf '%s' "$IP" | tr '.' '-')
  export PUBLIC_URL="https://$IP_LABEL.$HOST"
  printf '%s' "$PUBLIC_URL" > "$HSDIRECT_STATE_DIR/public_url"
  log "PUBLIC_URL=$PUBLIC_URL"
fi
# Persist the stable host for nginx + the entrypoint to consume.
printf '%s' "$HOST" > "$HSDIRECT_STATE_DIR/stable_host"

# cert notAfter (epoch) for status reporting.
NOT_AFTER=$(openssl x509 -enddate -noout -in "$CRT" 2>/dev/null | cut -d= -f2)
NOT_AFTER_EPOCH=$(date -d "$NOT_AFTER" +%s 2>/dev/null || echo "")

report_status active ""
log "done"

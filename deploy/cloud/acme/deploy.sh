#!/bin/sh
# Install the DNS-01 certificate; record TURN reload for the next idle-call window.
set -eu
DOMAIN=${PAIOS_DIRECT_HOST:?configure the DNS name in /srv/paios/acme/renew.env}
C=${PAIOS_ACME_PATH:-/srv/paios/acme}/certificates/$DOMAIN
TLS_DIR=${PAIOS_TLS_DIR:-/srv/paios/tls}
FRONT=${PAIOS_FRONT_CONTAINER:-paios-front-1}
LIVEKIT=${PAIOS_LIVEKIT_CONTAINER:-paios-livekit-1}
openssl x509 -in $C.crt -noout -checkend 86400 >/dev/null
test "$(openssl x509 -in $C.crt -noout -pubkey | sha256sum)" = "$(openssl pkey -in $C.key -pubout | sha256sum)"
# TURN reads its key at startup. Preserve active calls; the operator restarts it when idle.
printf '%s\n' "$LIVEKIT" > "$TLS_DIR/turn-reload-required"
echo "TURN_RELOAD_REQUIRED: $LIVEKIT; see $TLS_DIR/turn-reload-required"
install -m 600 -o root -g root $C.crt "$TLS_DIR"/fullchain.pem.new
install -m 600 -o root -g root $C.key "$TLS_DIR"/privkey.pem.new
mv "$TLS_DIR"/fullchain.pem.new "$TLS_DIR"/fullchain.pem
mv "$TLS_DIR"/privkey.pem.new "$TLS_DIR"/privkey.pem
docker exec "$FRONT" nginx -t -q
docker exec "$FRONT" nginx -s reload
echo "deployed $(openssl x509 -in "$TLS_DIR"/fullchain.pem -noout -subject -enddate | tr '\n' ' ')"

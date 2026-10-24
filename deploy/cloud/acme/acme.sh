#!/bin/sh
# DNS-01 certificate for the direct origin (no inbound 80/443 needed).
# Usage: acme.sh run    (first issuance)   |   acme.sh renew   (timer; renews <30 days, then deploys)
# Credentials: /srv/paios/acme/alidns.env (root 0600):  ALICLOUD_ACCESS_KEY=...  ALICLOUD_SECRET_KEY=...
# The Ubuntu lego build has no alidns provider, so DNS-01 goes through lego's exec provider + alidns-hook.py.
# Rehearsal: PAIOS_ACME_SERVER=https://acme-staging-v02.api.letsencrypt.org/directory PAIOS_ACME_PATH=/srv/paios/acme-staging acme.sh run
set -eu
DOMAIN=${PAIOS_DIRECT_HOST:?configure the DNS name in /srv/paios/acme/renew.env}
EMAIL=${PAIOS_ACME_EMAIL:?Set the ACME account email}
ACME_PATH=${PAIOS_ACME_PATH:-/srv/paios/acme}
set -a; . /srv/paios/acme/alidns.env; set +a
export ALICLOUD_TTL=600 EXEC_PATH=/srv/paios/cm2/acme/alidns-hook.py EXEC_PROPAGATION_TIMEOUT=900 EXEC_POLLING_INTERVAL=15
L="lego ${PAIOS_ACME_SERVER:+--server $PAIOS_ACME_SERVER} --accept-tos --email $EMAIL --path $ACME_PATH --key-type ec256 --dns exec --domains $DOMAIN"
case "${1:-renew}" in
  run)   $L run ;;
  renew) $L renew --days 30 --renew-hook /srv/paios/cm2/acme/deploy.sh ;;
  *) echo "usage: $0 run|renew" >&2; exit 2 ;;
esac

#!/bin/sh
set -eu
# Replies to Hermes' inbound SSH are allowed; new private-network connections are not.
iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -A OUTPUT -o lo -j ACCEPT
for subnet in 0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.0.0.0/24 192.168.0.0/16 198.18.0.0/15 224.0.0.0/4 240.0.0.0/4; do
    iptables -A OUTPUT -d "$subnet" -j REJECT
done
# Block our own public IPv4 (rendered by prepare-secrets.py) and every configured public API/LiveKit host;
# public internet APIs remain directly reachable. IPv6 is disabled by Compose.
address=$(python3 -c "import ipaddress; from pathlib import Path; print(ipaddress.IPv4Address(Path('/run/workshop-public-ipv4').read_text().strip()))")
iptables -A OUTPUT -d "$address" -j REJECT
IFS=,
set -f
set -- ${PAIOS_WORKSHOP_DENY_HOSTS:?render the public endpoint list first}
unset IFS
[ "$#" -le 11 ] || exit 2
for host do
    addresses=$(getent ahostsv4 "$host")
    [ -n "$addresses" ] || exit 2
    for address in $(printf '%s\n' "$addresses" | awk '{print $1}' | sort -u); do
        iptables -A OUTPUT -d "$address" -j REJECT
    done
done
cp /etc/ssh/sshd_config /run/workshop-sshd.conf
install -d -m 755 /run/sshd
install -d -o 0 -g 10001 -m 2770 /workshop
install -d -m 700 /run/workshop-scopes
install -d -o 0 -g 0 -m 700 /srv/workshop-snapshots
install -d -o 0 -g 0 -m 711 /srv/owner/out
/usr/local/bin/workshop-scope --sweep
install -d -m 700 /var/lib/workshop-ssh
if [ ! -f /var/lib/workshop-ssh/host_ed25519 ]; then
    ssh-keygen -q -t ed25519 -N '' -f /var/lib/workshop-ssh/host_ed25519
fi
# The trusted broker retains namespace/identity capabilities; tasks drop ALL capabilities.
# Neither broker nor tasks can change the initialized firewall.
exec setpriv --inh-caps=-all --ambient-caps=-all --bounding-set=-net_admin /usr/sbin/sshd -D -e -f /run/workshop-sshd.conf

#!/bin/sh
# Build locally from source. --up prepares and starts the single-host profile.
set -eu
cd "$(dirname "$0")"
up=0
env_file=.env
docker_build() {
    if [ "$up" = 1 ]; then
        docker build --build-arg HTTP_PROXY --build-arg HTTPS_PROXY --build-arg NO_PROXY \
            --build-arg http_proxy --build-arg https_proxy --build-arg no_proxy "$@"
    else
        docker build "$@"
    fi
}
if [ "${1:-}" = --up ]; then
    up=1
    shift
    if [ "${1:-}" = --env-file ]; then env_file=$2; shift 2; fi
    [ "$#" = 0 ] || { echo "Usage: build.sh [--up [--env-file PATH]]" >&2; exit 2; }
    set -a
    . "$(realpath "$env_file")"
    set +a
    export PAIOS_DEPLOYMENT=single-host
    case "${PAIOS_ENABLE_PHONE:-0}" in
        0) export PAIOS_PHONE_PROVIDER=off ;;
        1) [ "${PAIOS_PHONE_PROVIDER:-off}" != off ] || { echo 'PAIOS_PHONE_PROVIDER is required with PAIOS_ENABLE_PHONE=1' >&2; exit 2; } ;;
        *) echo 'PAIOS_ENABLE_PHONE must be 0 or 1' >&2; exit 2 ;;
    esac
    COMPOSE_PROFILES=single-host
    for component in OWNER_MAC EDGE COLD_STORAGE AVATAR AMAP MIHOME WECHAT SELF_REPAIR; do
        eval "enabled=\${PAIOS_ENABLE_$component:-0}"
        case "$enabled" in 0|1) ;; *) echo "PAIOS_ENABLE_$component must be 0 or 1" >&2; exit 2 ;; esac
        if [ "$enabled" = 1 ]; then
            case "$component" in
                OWNER_MAC) COMPOSE_PROFILES=$COMPOSE_PROFILES,owner-mac; export PAIOS_SINGLE_HOST_MAC_ROOT=/run/owner-mac ;;
                EDGE) COMPOSE_PROFILES=$COMPOSE_PROFILES,edge-forward ;;
                COLD_STORAGE) COMPOSE_PROFILES=$COMPOSE_PROFILES,cold-storage ;;
                SELF_REPAIR) echo "Self-repair needs an isolated staging host and configured release runner; see docs/first-run.md" >&2; exit 2 ;;
            esac
        fi
    done
    if [ "${PAIOS_ENABLE_WECHAT:-0}" = 1 ] && [ "${PAIOS_ENABLE_OWNER_MAC:-0}" != 1 ]; then
        echo 'PAIOS_ENABLE_WECHAT=1 requires PAIOS_ENABLE_OWNER_MAC=1' >&2
        exit 2
    fi
    export COMPOSE_PROFILES
    root=$(cd ../.. && pwd)
    docker_build -f Dockerfile.prepare -t paios-prepare:local ../..
    prepare() {
        docker run --rm --env-file "$env_file" -e PAIOS_DEPLOYMENT=single-host -e PAIOS_PHONE_PROVIDER \
            -e HTTP_PROXY -e HTTPS_PROXY -e NO_PROXY -e http_proxy -e https_proxy -e no_proxy \
            -e "PAIOS_HERMES_NATIVE_ROOT=$root/deploy/cloud/.build/native" \
            -v "$root:$root" -w "$root/deploy/cloud" paios-prepare:local "$@"
    }
    prepare python3 prepare-secrets.py --bootstrap --uid 10000 --secrets-dir "$PAIOS_SECRETS_DIR" \
        --tls-dir "$PAIOS_TLS_DIR" --public-host "$PAIOS_PUBLIC_HOST" --public-ipv4 "$PAIOS_PUBLIC_IPV4"
fi
: "${PAIOS_GATEWAY_IMAGE:?Set an explicit candidate image tag}"
: "${PAIOS_HERMES_IMAGE:?Set an explicit candidate image tag}"
: "${PAIOS_FRONT_IMAGE:?Set an explicit candidate image tag}"
: "${PAIOS_WORKSHOP_IMAGE:?Set an explicit candidate image tag}"
for image in "$PAIOS_GATEWAY_IMAGE" "$PAIOS_HERMES_IMAGE" "$PAIOS_FRONT_IMAGE" "$PAIOS_WORKSHOP_IMAGE"; do
    case "$image" in *@*|*[!a-zA-Z0-9_./:-]*) echo "Build requires mutable image tags" >&2; exit 1 ;; esac
    case "${image##*/}" in *:*) ;; *) echo "Build requires explicit image tags" >&2; exit 1 ;; esac
done
mirror=${PAIOS_BUILD_MAINLAND_MIRRORS:-0}
case "$mirror" in 0|1) ;; *) echo "PAIOS_BUILD_MAINLAND_MIRRORS must be 0 or 1" >&2; exit 1 ;; esac
if [ "$up" = 1 ]; then
    prepare python3 prepare-build.py
    # The host owns the persistent loop mount; the unprivileged prepare container cannot create it.
    python3 migrate.py prepare-workshop --compose compose.yaml --env-file "$env_file"
else
    python3 prepare-build.py
fi
started=$(date +%s)
docker_build --build-arg PAIOS_BUILD_MAINLAND_MIRRORS="$mirror" -f .build/hermes-base.Dockerfile -t paios-hermes-base:locked "$(readlink -f .build/hermes)"
printf 'build_wall_seconds image=%s seconds=%s\n' paios-hermes-base:locked "$(($(date +%s) - started))"
started=$(date +%s)
docker_build --build-arg PAIOS_BUILD_MAINLAND_MIRRORS="$mirror" -f Dockerfile.gateway -t "$PAIOS_GATEWAY_IMAGE" ../..
printf 'build_wall_seconds image=%s seconds=%s\n' "$PAIOS_GATEWAY_IMAGE" "$(($(date +%s) - started))"
started=$(date +%s)
docker_build --build-arg PAIOS_BUILD_MAINLAND_MIRRORS="$mirror" -f Dockerfile.hermes -t "$PAIOS_HERMES_IMAGE" ../..
printf 'build_wall_seconds image=%s seconds=%s\n' "$PAIOS_HERMES_IMAGE" "$(($(date +%s) - started))"
started=$(date +%s)
docker_build -f Dockerfile.front -t "$PAIOS_FRONT_IMAGE" ../..
printf 'build_wall_seconds image=%s seconds=%s\n' "$PAIOS_FRONT_IMAGE" "$(($(date +%s) - started))"
started=$(date +%s)
docker_build --build-arg PAIOS_BUILD_MAINLAND_MIRRORS="$mirror" --build-context "gateway_runtime=docker-image://$PAIOS_GATEWAY_IMAGE" -f Dockerfile.workshop -t "$PAIOS_WORKSHOP_IMAGE" ../..
printf 'build_wall_seconds image=%s seconds=%s\n' "$PAIOS_WORKSHOP_IMAGE" "$(($(date +%s) - started))"
typescript=$(docker run --rm --entrypoint node "$PAIOS_GATEWAY_IMAGE" -p 'require("/opt/paios/01-product-half-finished/backend/phase0/gateway/package.json").devDependencies.typescript')
docker run --rm --network none --read-only --user 10001:10001 --memory 512m --memory-swap 512m --cpus 1 \
    --tmpfs /workshop:rw,noexec,nosuid,nodev,size=64m,uid=10001,gid=10001,mode=0700 \
    --mount "type=bind,source=$(cd ../.. && pwd)/tests/hermes/workshop_typescript_probe.py,target=/probe.py,readonly" \
    --entrypoint python3 "$PAIOS_WORKSHOP_IMAGE" /probe.py --expected-version "$typescript"

if [ "$up" = 1 ]; then
    compose() {
        docker compose --env-file "$env_file" --env-file .build/production.public.env \
            -f compose.yaml -f compose.single-host.yaml "$@"
    }
    enabled_services=$(compose config --services)
    enabled_services=" $(printf '%s\n' "$enabled_services" | tr '\n' ' ') "
    all_services=$(compose --profile '*' config --services)
    disabled_services=
    for service in $all_services; do
        case "$enabled_services" in
            *" $service "*) ;;
            *) disabled_services="$disabled_services $service" ;;
        esac
    done
    if [ -n "$disabled_services" ]; then
        compose --profile '*' stop $disabled_services
    fi
    compose up -d --wait front postgres livekit
    prepare python3 single_host_models.py --keys "$PAIOS_SECRETS_DIR" | \
        compose run -T --rm --no-deps gateway node deploy/cloud/model-settings-project.ts \
            --directory /var/lib/paios/central-storage/model-settings \
            --master /run/secrets/model-settings-master.key --environment production \
            --output /var/lib/paios/model-projections --profile owner --revision current --group brain \
            --import /etc/paios/model-settings-import.json --bootstrap --keys-stdin --publish
    compose run -T --rm --no-deps gateway node deploy/cloud/model-settings-project.ts \
        --directory /var/lib/paios/central-storage/model-settings \
        --master /run/secrets/model-settings-master.key --environment production \
        --output /var/lib/paios/model-projections --profile workshop --revision current --group build --publish
    compose run --rm --no-deps gateway node \
        01-product-half-finished/backend/phase0/gateway/tools/mac-product-provision.ts init \
        --root /var/lib/paios --config /etc/paios/cloud.json
    compose up -d --force-recreate --wait --wait-timeout 240
    # Gateway needs the API to initialize; Hermes discovers Gateway's MCP at process startup.
    # Complete that second phase only after the shared Gateway host is healthy.
    compose up -d --no-deps --force-recreate --wait --wait-timeout 240 hermes
    echo "Single-host services are ready. Pair a client as described in docs/first-run.md."
fi

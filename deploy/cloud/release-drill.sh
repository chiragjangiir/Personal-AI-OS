#!/bin/bash
# Release drills through the one release entry point (operator-run, root).
#
# Staging (staging config only):
#   release-drill.sh /etc/paios/release-builder.json [FAIL_AFTER_SECONDS=420]
#   1. candidate -> previous -> candidate with `release.py rollback` (a pointer swap plus the shared start sequence);
#   2. delayed unhealthy: switch a fault release whose gateway /healthz turns 500 after FAIL_AFTER seconds, let the
#      staging watchdog roll it back by itself, then check the pointers, the running images and the single attempt.
#   Precondition: staging current = an accepted candidate C, previous = the release P before it, and the staging
#   release config names a measured watchdog timing file and the staging owner identity.
#
# 依米 candidate, end to end (a comment-only change, so the owner sees two drill notices and nothing else changes):
#   release-drill.sh agent-builder /etc/paios/release-builder.json [FILE]
#     queue a repair request exactly as the builder does (on production's published commit), let the requests unit
#     build, test, stage and package it, and check the package in the exchange;
#   release-drill.sh agent-production /etc/paios/release-production.json <request_id>
#     let `ship` pull, verify and load it and switch at an idle moment, check pointers, images and the owner notice,
#     then drop a 「改回去」 request as her skills_hub(action="release_rollback") does and check the rollback, its
#     notice, and that a second request is refused.
set -euo pipefail
TOOLS=$(cd "$(dirname "$0")" && pwd)
MODE=staging
case "${1:-}" in agent-builder|agent-production) MODE=$1; shift;; esac
CONFIG=${1:?release config}
R() { python3 "$TOOLS/release.py" --config "$CONFIG" "$@"; }
value() { python3 -c 'import json,sys; c=json.load(open(sys.argv[1])); print(eval(sys.argv[2], {}, {"c": c}))' "$CONFIG" "$1"; }
field() { python3 -c 'import json,sys; v=json.load(open(sys.argv[1])); print(eval(sys.argv[2], {}, {"v": v}))' "$@" 2>/dev/null || true; }
ROOT=$(value 'c["root"]'); PROJECT=$(value 'c["project"]'); SUFFIX=$([ "$(value 'c["stage"]')" = staging ] && echo -staging || true)
running() { docker inspect --format '{{.Image}}' "$(docker ps -q --filter label=com.docker.compose.project="$PROJECT" --filter label=com.docker.compose.service=gateway$SUFFIX)"; }
pinned() { sed -n 's/^PAIOS_GATEWAY_IMAGE=//p' "$1/.release/env"; }
expect() { # <release dir>: current points there and its pinned gateway image is the one running
  test "$(readlink -f "$ROOT/current")" = "$1" || { echo "DRILL FAIL: current is $(readlink -f "$ROOT/current"), expected $1"; exit 1; }
  test "$(running)" = "$(pinned "$1")" || { echo "DRILL FAIL: running gateway $(running) != $(pinned "$1")"; exit 1; }
  echo "OK current=$1 gateway=$(running)"; }
state_dir() { docker inspect --format '{{range .Mounts}}{{if eq .Destination "/watchdog"}}{{.Source}}{{end}}{{end}}' \
  "$(docker ps -q --filter label=com.docker.compose.project="$PROJECT" --filter label=com.docker.compose.service=release-watchdog$SUFFIX)"; }
count() { python3 -c 'import json,sys; print(sum(1 for l in open(sys.argv[1]) if (e:=json.loads(l)).get("event")==sys.argv[2] and all(e.get(k)==v for k,v in (a.split("=",1) for a in sys.argv[3:]))))' "$STATE/events.jsonl" "$@" 2>/dev/null || echo 0; }
seen() { test "$(count "$@")" = 1; } # <event> [key=value...]: exactly one such event
wait_for() { # <seconds> <description> <command...>: poll every 15 s (the command is re-run each time)
  local deadline=$(( $(date +%s) + $1 )) what=$2; shift 2
  until "$@"; do [ "$(date +%s)" -lt "$deadline" ] || { echo "DRILL FAIL: $what"; exit 1; }; sleep 15; done; }

if [ "$MODE" = agent-builder ]; then
  FILE=${2:-01-product-half-finished/backend/services/personal-aios-integration/src/server.ts}
  REPO=$(value 'c["repo"]'); REQUESTS=$(value 'c["requests"]'); EXCHANGE=$(value 'c["exchange"]')
  BASE=$(field "$EXCHANGE/production.json" 'v["commit"]'); test ${#BASE} = 40
  ID=$(python3 -c 'import uuid; print(uuid.uuid4().hex[:12])')
  W=$(mktemp -d); trap 'git -C "$REPO" worktree remove --force "$W/src" 2>/dev/null || true; rm -rf "$W"' EXIT
  git -C "$REPO" worktree add -q --detach "$W/src" "$BASE"
  printf '\n// release drill %s\n' "$ID" >> "$W/src/$FILE"
  git -C "$W/src" -c user.name=yimi -c user.email=yimi@paios.invalid -c commit.gpgsign=false commit -qam '发布流程演练（只加了一行注释，没有功能变化）'
  mkdir -m 750 "$REQUESTS/.$ID"
  git -C "$W/src" format-patch --binary --stdout "$BASE..HEAD" > "$REQUESTS/.$ID/candidate.patch"
  printf '{"schema":"paios.release-request.v1","request_id":"%s","base":"%s","run_id":"drill"}\n' "$ID" "$BASE" > "$REQUESTS/.$ID/request.json"
  chown -R 10000:10000 "$REQUESTS/.$ID"; mv "$REQUESTS/.$ID" "$REQUESTS/$ID"
  echo "queued $ID on production $BASE; waiting for build, suites, staging and packaging"
  finished() { test -n "$(field "$REQUESTS/$ID/result.json" 'v.get("finished_at","")')"; }
  wait_for 10800 "no result for $ID" finished
  test "$(field "$REQUESTS/$ID/result.json" 'v.get("ready_for_production")')" = True || { echo "DRILL FAIL: $(field "$REQUESTS/$ID/result.json" 'v.get("failure")')"; exit 1; }
  test -s "$EXCHANGE/candidates/$ID/delta.tar" && test -s "$EXCHANGE/candidates/$ID/source.bundle"
  field "$EXCHANGE/candidates/$ID/manifest.json" '{k: v[k] for k in ("commit", "base", "summary", "delta_bytes", "reused_bytes")}'
  echo "BUILDER PASS: $ID packaged. On production: release-drill.sh agent-production /etc/paios/release-production.json $ID"
  exit 0
fi

if [ "$MODE" = agent-production ]; then
  ID=${2:?request id}; SPOOL=$(value 'c["spool"]'); STATE=$(state_dir)
  status() { field "$SPOOL/status/$1.json" 'v.get("state","")'; }
  ship() { R ship || [ $? = 75 ]; }
  settled() { ship; case "$(status "$1")" in "$2"|refused|stale_base|transfer_failed|switch_failed|failed) return 0;; esac; return 1; }
  C0=$(readlink -f "$ROOT/current")
  echo "== production ships $ID at an idle moment"
  wait_for 7200 "$ID not settled (state $(status "$ID"))" settled "$ID" switched
  test "$(status "$ID")" = switched || { echo "DRILL FAIL: $(status "$ID") $(field "$SPOOL/status/$ID.json" 'v.get("reason")')"; exit 1; }
  C1=$(readlink -f "$ROOT/current"); test "$C1" != "$C0"; expect "$C1"; test "$(readlink -f "$ROOT/previous")" = "$C0"
  RELEASE_ID=$(field "$SPOOL/status/$ID.json" 'v["release_id"]')
  wait_for 900 "shipped notice not delivered (owner unreachable?)" seen notice_delivered id=release-shipped:$RELEASE_ID
  echo "== 「改回去」"
  RID=$(python3 -c 'import uuid; print(uuid.uuid4().hex[:12])')
  printf '{"request_id":"%s","reason":"演练：改回去"}\n' "$RID" > "$SPOOL/rollback/$RID.json"; chown 10000:10000 "$SPOOL/rollback/$RID.json"
  wait_for 3600 "rollback-$RID not settled" settled "rollback-$RID" done
  test "$(status "rollback-$RID")" = done || { echo "DRILL FAIL: rollback $(status "rollback-$RID")"; exit 1; }
  expect "$C0"; test "$(readlink -f "$ROOT/previous")" = "$C1"
  wait_for 900 "reverted notice not delivered" seen notice_delivered id=release-reverted:$RELEASE_ID
  RID2=$(python3 -c 'import uuid; print(uuid.uuid4().hex[:12])')
  printf '{}\n' > "$SPOOL/rollback/$RID2.json"; ship
  test "$(status "rollback-$RID2")" = refused; expect "$C0"
  echo "DRILL PASS: $ID request -> stage -> transfer -> idle switch -> 改回去 ($RELEASE_ID)"
  exit 0
fi

test "$SUFFIX" = -staging
C=$(readlink -f "$ROOT/current"); P=$(readlink -f "$ROOT/previous")
test "$C" != "$P"
echo "== 1. candidate -> previous -> candidate"
R rollback; expect "$P"
R rollback; expect "$C"

echo "== 2. delayed unhealthy rollback by the watchdog"
FAIL_AFTER=${2:-420}
GOOD=$(pinned "$C")
GOOD_TAG=paios-gateway:watchdog-base-${GOOD#sha256:}
docker image tag "$GOOD" "$GOOD_TAG"
docker build -q --build-arg GOOD_IMAGE="$GOOD_TAG" -f "$C/deploy/cloud/watchdog-drill/Dockerfile" -t paios-gateway:watchdog-drill "$C" > /dev/null
printf 'FROM paios-gateway:watchdog-drill\nENV PAIOS_DRILL_FAIL_AFTER_SECONDS=%s\n' "$FAIL_AFTER" | docker build -q -t paios-gateway:watchdog-drill - > /dev/null
FAULT=$(docker image inspect --format '{{.Id}}' paios-gateway:watchdog-drill)
D=$ROOT/releases/drill-$(date -u +%Y%m%dT%H%M%SZ)
# The fault release is C's tree and receipts with only the gateway image replaced (never a production image).
cp -a "$C" "$D"
rm -f "$D"/.release/switch-*.json "$D"/.release/front*.{json,conf,js} "$D"/.release/postgres-before.dump
python3 - "$D/.release/accepted.json" "$FAULT" <<'PY'
import json,sys
path,fault=sys.argv[1:]; accepted=json.load(open(path)); accepted['images']['gateway']=fault; accepted['drill']='watchdog fault fixture'
json.dump(accepted,open(path,'w'),indent=2)
PY
R switch "$(basename "$D")"
expect "$D"
WATCHDOG=$(docker ps -q --filter label=com.docker.compose.project="$PROJECT" --filter label=com.docker.compose.service=release-watchdog-staging)
STATE=$(state_dir)
RELEASE_ID=$(field "$STATE/release.json" 'v["release_id"]')
WINDOW=$(field "$STATE/release.json" 'int(v["timing"]["unhealthy_seconds"]+v["timing"]["healthy_seconds"]+v["timing"]["rollback_timeout_seconds"])')
echo "armed $RELEASE_ID; waiting ${FAIL_AFTER}s fault delay + ${WINDOW}s watchdog window"
wait_for $(( FAIL_AFTER + WINDOW + 120 )) "no healthy rollback notice for $RELEASE_ID" seen rollback_healthy_notified release_id=$RELEASE_ID
expect "$C"
test "$(readlink -f "$ROOT/previous")" = "$D"
test "$(count rollback_started release_id=$RELEASE_ID)" = 1
field "$STATE/$RELEASE_ID.json" 'v["phase"]' | grep -qx notified
echo "== 3. no second rollback and no roll-forward after a watchdog restart"
docker restart "$WATCHDOG" > /dev/null
sleep "$(field "$STATE/release.json" 'int(v["timing"]["unhealthy_seconds"])+30')"
expect "$C"
test "$(count rollback_started release_id=$RELEASE_ID)" = 1
echo "DRILL PASS: candidate->previous->candidate and delayed unhealthy rollback ($RELEASE_ID)"

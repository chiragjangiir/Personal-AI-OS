#!/usr/bin/env python3
"""Observe one release; Compose remains the image-switch authority."""
import fcntl
import json
import os
from pathlib import Path
import re
import shlex
import time

from watchdog_platform import Platform


def validate_release_id(value):
    if not re.fullmatch(r"[A-Za-z0-9_.-]{1,80}", value):
        raise ValueError("invalid release identity")


def release_files(release):
    """The Compose inputs a release directory owns: its tree, its stage env and its rendered public env."""
    release = Path(release)
    return {"compose": str(release / "deploy/cloud/compose.yaml"), "env_file": str(release / ".release/env"),
            "public_env_file": str(release / "deploy/cloud/.build/production.public.env")}


def compose_files(compose, env_file):
    """Preserve the provisioned workshop client whenever recreating this stack."""
    configured = False
    for line in Path(env_file).read_text().splitlines():
        assignment = re.match(r"\s*(?:export\s+)?PAIOS_BUILDER_URL\s*=\s*(.*)$", line)
        if assignment:
            value = shlex.split(assignment[1], comments=True)
            configured = bool(value and value[0])
    files = [str(compose)]
    if configured:
        files.append(str(Path(compose).parent / 'compose.workshop-client.yaml'))
    return [part for path in files for part in ('-f', path)]


def validate(record):
    if record["schema"] != 2:
        raise ValueError("invalid release schema")
    validate_release_id(record["release_id"])
    if record["profile"] not in ("production", "staging"):
        raise ValueError("invalid release profile")
    if not re.fullmatch(r"[a-z0-9][a-z0-9_-]*", record["project"]):
        raise ValueError("invalid Compose project")
    for key in ("root", "candidate_release", "previous_release"):
        if not Path(record[key]).is_absolute():
            raise ValueError("release paths must be absolute")
    if record["candidate_release"] == record["previous_release"]:
        raise ValueError("candidate and previous must be distinct releases")
    expected = Path(record["previous_release"]) / ".release" / ("watchdog-" + record["release_id"] + ".compose.json")
    if record["previous_compose"] != str(expected) or not re.fullmatch(r"[a-f0-9]{64}", record["previous_compose_sha256"]):
        raise ValueError("invalid prepared previous Compose model")
    suffix = "-staging" if record["profile"] == "staging" else ""
    names, variables = set(), {}
    for item in record["services"]:
        if item["service"] not in {name + suffix for name in ("gateway", "hermes", "workshop", "workshop-link")}:
            raise ValueError("release unit must exclude stateful services and the network namespace")
        if item["service"] in names or (item["variable"] in variables and variables[item["variable"]] != (item["candidate"], item["previous"])):
            raise ValueError("inconsistent release service or image variable")
        names.add(item["service"])
        variables[item["variable"]] = (item["candidate"], item["previous"])
        if not re.fullmatch(r"PAIOS_[A-Z_]+_IMAGE", item["variable"]):
            raise ValueError("invalid image variable")
        for key in ("candidate", "previous"):
            if not re.fullmatch(r"sha256:[a-f0-9]{64}", item[key]):
                raise ValueError("record resolved immutable local image IDs")
    if "gateway" + suffix not in names:
        raise ValueError("release unit must include gateway")
    timing = record["timing"]
    for key in ("poll_seconds", "unhealthy_seconds", "restart_window_seconds", "restart_limit",
                "healthy_seconds", "rollback_timeout_seconds", "probe_timeout_seconds"):
        if not isinstance(timing[key], (int, float)) or not 0 < timing[key] < 86400:
            raise ValueError("invalid watchdog timing")
    if timing["rollback_timeout_seconds"] <= timing["healthy_seconds"]:
        raise ValueError("rollback timeout must include healthy confirmation")
    if not isinstance(timing["restart_limit"], int) or timing["restart_limit"] > 100:
        raise ValueError("restart limit must be a bounded integer")
    return record


class Watchdog:
    def __init__(self, platform, clock=time.monotonic, wall_clock=time.time):
        self.platform, self.clock, self.wall_clock = platform, clock, wall_clock
        self.record = None
        self.bad_since = self.good_since = None
        self.restarts, self.last = [], {}

    def tick(self, record, state):
        now, timing = self.clock(), record["timing"]
        if self.record != record:
            self.record = record
            self.bad_since = self.good_since = None
            self.restarts, self.last = [], {}
        snapshot, healthy = self.platform.observe(record)
        changed = False
        for name, current in snapshot.items():
            prior = self.last.get(name)
            if prior:
                delta = (max(0, current["restarts"] - prior["restarts"])
                         if current["id"] == prior["id"] else 1)
                changed = changed or delta > 0
                self.restarts.extend([now] * min(delta, int(timing["restart_limit"])))
        self.last.update(snapshot)
        self.restarts = [t for t in self.restarts if now - t < timing["restart_window_seconds"]]
        # A manual switch or a newer release must never be overwritten.
        if any(row["image"] not in (item["candidate"], item["previous"])
               for item in record["services"] if (row := snapshot.get(item["service"]))):
            self.bad_since = self.good_since = None
            return "superseded"
        previous = all(snapshot.get(item["service"], {}).get("image") == item["previous"]
                       for item in record["services"])
        if state:
            if state["record"] != record:
                raise ValueError("release_id reused with different contract")
            if state["phase"] == "notified":
                return "done"
            stable = healthy and previous and not changed
            self.good_since = (now if self.good_since is None else self.good_since) if stable else None
            if self.good_since is not None and now - self.good_since >= timing["healthy_seconds"]:
                self.platform.notify(record, state)
                state["phase"] = "notified"
                self.platform.save(record, state)
                return "notified"
            if self.wall_clock() - state["attempted_at"] >= timing["rollback_timeout_seconds"] and state["phase"] != "failed":
                state["phase"] = "failed"
                self.platform.save(record, state)
                self.platform.event(record, "rollback_unhealthy")
            return state["phase"]
        if previous:
            self.bad_since = None
            return "previous"
        self.bad_since = (now if self.bad_since is None else self.bad_since) if not healthy else None
        outage = self.bad_since is not None and now - self.bad_since >= timing["unhealthy_seconds"]
        storm = len(self.restarts) >= timing["restart_limit"]
        if not (outage or storm):
            return "observing"
        state = {"phase": "verifying", "record": record, "attempted_at": self.wall_clock(),
                 "reason": "restart_storm" if storm else "unhealthy_window"}
        # Persist the single attempt BEFORE changing desired state or invoking Compose.
        self.platform.save(record, state)
        self.platform.event(record, "rollback_started", reason=state["reason"])
        self.platform.rollback(record)
        return "verifying"


def main():
    os.umask(0o077)
    root = Path(os.environ.get("PAIOS_WATCHDOG_STATE", "/watchdog"))
    root.mkdir(parents=True, exist_ok=True)
    platform, watchdog = Platform(root), None
    watchdog = Watchdog(platform)
    while True:
        interval = 5
        try:
            with (root / "release.lock").open("a") as lock:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                if (root / "release.json").exists():
                    record = validate(json.loads((root / "release.json").read_text()))
                    if record["profile"] != os.environ["PAIOS_WATCHDOG_PROFILE"]:
                        raise ValueError("release profile does not match watchdog network scope")
                    interval = record["timing"]["poll_seconds"]
                    state_file = root / (record["release_id"] + ".json")
                    state = json.loads(state_file.read_text()) if state_file.exists() else None
                    platform.lock = lock
                    watchdog.tick(record, state)
        except BlockingIOError:
            pass  # The release script owns the switch and its health gate.
        except (OSError, ValueError, KeyError) as error:
            print(json.dumps({"event": "watchdog_error", "error": type(error).__name__, "detail": str(error)}), flush=True)
            watchdog = Watchdog(platform)
        time.sleep(interval)


if __name__ == "__main__":
    main()

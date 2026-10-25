#!/usr/bin/env python3
"""Release-script hook: publish the only rollback contract after its gates pass."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import subprocess

from watchdog_platform import atomic_json, atomic_write
from release_watchdog import compose_files, release_files, validate, validate_release_id


def compose_config_command(release, project, profile, services):
    files = release_files(Path(release).resolve())
    return ["docker", "compose", "-p", project, "--env-file", files["env_file"],
            "--env-file", files["public_env_file"]] + compose_files(files["compose"], files["env_file"]) + [
            "--profile", profile, "config", "--format", "json", *services]


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("release-id", "project", "profile", "root", "candidate-release", "previous-release",
                 "state-dir", "timing", "principal-id", "device-id"):
        parser.add_argument("--" + name, required=True)
    parser.add_argument("--unit", action="append", required=True, help="SERVICE:PAIOS_IMAGE_VARIABLE")
    parser.add_argument("--compose-profile", action="append")
    parser.add_argument("--lock-fd", type=int, required=True)
    parser.add_argument("--mode", choices=("prepare", "arm"), required=True)
    args = parser.parse_args()
    root = Path(args.state_dir).resolve()
    if os.fstat(args.lock_fd).st_ino != (root / "release.lock").stat().st_ino:
        raise ValueError("release script must hold the shared release lock")
    fcntl.flock(args.lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    validate_release_id(args.release_id)
    pending = root / ("pending-" + args.release_id + ".json")
    path = root / "release.json"
    if (root / (args.release_id + ".json")).exists() or (path.exists() and json.loads(path.read_text())["release_id"] == args.release_id):
        raise ValueError("release IDs must never be reused")
    environment = {key: value for key, value in os.environ.items() if not key.startswith("PAIOS_")}
    def run(command, env=environment):
        return subprocess.check_output(command, env=env, text=True, stderr=subprocess.DEVNULL)
    def running_image(service):
        filters = ["--filter", "label=com.docker.compose.project=" + args.project, "--filter", "label=com.docker.compose.service=" + service]
        containers = run(["docker", "ps", "-aq", *filters]).split()
        if len(containers) != 1:
            raise ValueError("expected one existing container per service")
        return json.loads(run(["docker", "container", "inspect", containers[0]]))[0]["Image"]
    if args.mode == "arm":
        record = validate(json.loads(pending.read_text()))
        if hashlib.sha256(Path(record["previous_compose"]).read_bytes()).hexdigest() != record["previous_compose_sha256"]:
            raise ValueError("prepared previous Compose model changed")
        if any(running_image(item["service"]) != item["candidate"] for item in record["services"]):
            raise ValueError("running candidate differs from prepared immutable image")
        atomic_json(path, record)
        pending.unlink()
        print(json.dumps({"event": "watchdog_armed", "release_id": args.release_id}))
        return
    previous_compose = Path(args.previous_release).resolve() / ".release" / ("watchdog-" + args.release_id + ".compose.json")
    if pending.exists() or previous_compose.exists():
        raise ValueError("release IDs must never be reused")
    units = [unit.split(":", 1) for unit in args.unit]
    models = {}
    def model(release, variable=None):
        key = (str(Path(release).resolve()), variable)
        if key not in models:
            env = dict(environment, **{variable: "paios-watchdog-contract-probe:unused"}) if variable else environment
            raw = run(compose_config_command(release, args.project, args.profile, [service for service, _ in units]), env)
            models[key] = (raw, json.loads(raw))
        return models[key]
    def image_id(definition, service):
        return json.loads(run(["docker", "image", "inspect", definition["services"][service]["image"]]))[0]["Id"]
    previous_text, previous_model = model(args.previous_release)
    _, candidate_model = model(args.candidate_release)
    services = []
    for service, variable in units:
        # Enforce that the named source assignment controls this Compose image.
        if model(args.candidate_release, variable)[1]["services"][service]["image"] != "paios-watchdog-contract-probe:unused":
            raise ValueError("unit image variable does not control Compose service")
        previous = running_image(service)
        # A pointer rollback restores the previous release's own env: it must name exactly the running image.
        if image_id(previous_model, service) != previous:
            raise ValueError("previous release env does not pin the running image of " + service)
        services.append({"service": service, "variable": variable,
                         "candidate": image_id(candidate_model, service), "previous": previous})
    record = {"schema": 2, "release_id": args.release_id, "project": args.project, "profile": args.profile,
              "root": str(Path(args.root).resolve()), "candidate_release": str(Path(args.candidate_release).resolve()),
              "previous_release": str(Path(args.previous_release).resolve()), "services": services,
              "previous_compose": str(previous_compose), "previous_compose_sha256": hashlib.sha256(previous_text.encode()).hexdigest(),
              "owner": {"principal_id": args.principal_id, "device_id": args.device_id},
              "timing": json.loads(Path(args.timing).read_text())}
    if args.compose_profile:
        record['profiles'] = args.compose_profile
    validate(record)
    # Compose config already escapes literal dollars for reloading; preserve its exact output.
    atomic_write(previous_compose, previous_text)
    atomic_json(pending, record)


if __name__ == "__main__":
    main()

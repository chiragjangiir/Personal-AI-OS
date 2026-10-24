"""Docker/Compose and existing owner-delivery protocol adapter."""
import http.client
import json
import os
from pathlib import Path
import socket
import time
import urllib.error
import urllib.parse
import urllib.request


def atomic_json(path, value, mode=0o600):
    atomic_write(path, json.dumps(value, sort_keys=True), mode)


def atomic_write(path, text, mode=0o600):
    temporary = path.with_name(path.name + ".watchdog.tmp")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, mode)
    with os.fdopen(fd, "w") as stream:
        os.fchmod(stream.fileno(), mode)
        stream.write(text)
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(path)
    fd = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def point(root, name, release):
    """Atomically repoint root/<name> (current or previous) at a release directory below root."""
    root, release = Path(root), Path(release)
    link = root / name
    temporary = root / ("." + name + ".tmp")
    if temporary.is_symlink():
        temporary.unlink()
    os.symlink(os.path.relpath(release, root), temporary)
    temporary.replace(link)
    fd = os.open(root, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


class Platform:
    def __init__(self, root):
        self.root, self.lock = root, None
        self.http = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def engine(self, path):
        connection = http.client.HTTPConnection("localhost", timeout=5)
        connection.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        connection.sock.settimeout(5)
        connection.sock.connect("/var/run/docker.sock")
        try:
            connection.request("GET", path)
            response = connection.getresponse()
            if response.status != 200:
                raise OSError("Docker Engine observation failed")
            return json.loads(response.read())
        finally:
            connection.close()

    def observe(self, record):
        filters = urllib.parse.quote(json.dumps({"label": ["com.docker.compose.project=" + record["project"]]}))
        containers = self.engine("/containers/json?all=1&filters=" + filters)
        snapshot, healthy = {}, True
        for item in record["services"]:
            matches = [row for row in containers if row["Labels"].get("com.docker.compose.service") == item["service"]
                       and row["Labels"].get("com.docker.compose.oneoff", "False").lower() == "false"]
            if len(matches) > 1:
                raise ValueError("release unit must have exactly one replica per service")
            if not matches:
                healthy = False
                continue
            row = self.engine("/containers/" + matches[0]["Id"] + "/json")
            snapshot[item["service"]] = {"id": row["Id"], "image": row["Image"], "restarts": row["RestartCount"]}
            healthy = healthy and row["State"]["Running"] and row["State"].get("Health", {"Status": "healthy"})["Status"] == "healthy"
        try:
            with self.http.open("http://127.0.0.1:" + os.environ.get("PAIOS_GATEWAY_PORT", "8787") + "/healthz",
                                timeout=record["timing"]["probe_timeout_seconds"]) as response:
                healthy = healthy and response.status == 200
        except (OSError, urllib.error.URLError):
            healthy = False
        return snapshot, healthy

    def save(self, record, state):
        if state['phase'] in ('verifying', 'failed'):
            from release_notice import failure, queue
            path = Path(record['candidate_release']) / '.release/request.json'
            if path.exists():
                spec = json.loads(path.read_text())
                if spec.get('origin'):
                    queue(self.root / 'notices', failure(spec, 'watchdog', state['phase']))
        atomic_json(self.root / (record["release_id"] + ".json"), state)

    def event(self, record, kind, **fields):
        event = {"schema": 1, "event": kind, "release_id": record["release_id"], "at": time.time(), **fields}
        line = json.dumps(event, sort_keys=True) + "\n"
        with (self.root / "events.jsonl").open("a") as stream:
            stream.write(line)
            stream.flush()
            os.fsync(stream.fileno())
        print(line, end="", flush=True)

    def rollback(self, record):
        # The release lock covers the pointer swap AND the Compose switch: the previous release's own tree,
        # env and rendered config become current again, exactly as a manual rollback does.
        from release_watchdog import release_files
        point(record["root"], "current", record["previous_release"])
        point(record["root"], "previous", record["candidate_release"])
        files = release_files(record["previous_release"])
        command = ["docker-compose", "-p", record["project"], "--project-directory", str(Path(files["compose"]).parent),
                   "--env-file", files["env_file"], "--env-file", files["public_env_file"], "-f", record["previous_compose"],
                   "--profile", record["profile"], "up", "-d", "--no-deps", "--no-build", "--pull", "never",
                   *[item["service"] for item in record["services"]]]
        environment = {key: value for key, value in os.environ.items() if not key.startswith("PAIOS_")}
        # Replace Python and invoke Compose directly, without a Docker CLI parent under the 32 MiB cap.
        # The platform restart policy resumes verification after Compose exits, even on failure.
        os.set_inheritable(self.lock.fileno(), True)
        os.execvpe(command[0], command, environment)

    def notify(self, record, state):
        release = record["release_id"]
        text = "系统消息：版本 " + release + " 持续异常，已自动回退到上一健康版本，并通过健康检查。"
        body = {**record["owner"], "id": "release-rollback:" + release, "text": text,
                "captured_at": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime(state["attempted_at"])),
                "system_event": {"type": "release_rollback", "release_id": release, "reason": state["reason"],
                                 "images": record["services"]}}
        token = Path("/run/secrets/hermes-internal.key").read_text().strip()
        request = urllib.request.Request("http://127.0.0.1:" + os.environ.get("PAIOS_INTEGRATION_PORT", "18661") +
                                         "/internal/hermes/scheduled-delivery", data=json.dumps(body).encode(),
                                         headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"})
        with self.http.open(request, timeout=20) as response:
            receipt = json.load(response)
            if receipt.get("status") != "delivered" or receipt.get("system_event_id") != body["id"]:
                raise ValueError("system notice was not accepted")
        self.event(record, "rollback_healthy_notified")

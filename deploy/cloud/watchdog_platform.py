"""Docker/Compose and existing owner-delivery protocol adapter."""
import http.client
import json
import os
from pathlib import Path
import socket
import subprocess
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


def engine(path, payload=None):
    connection = http.client.HTTPConnection("localhost", timeout=5)
    connection.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    connection.sock.settimeout(5)
    connection.sock.connect("/var/run/docker.sock")
    try:
        connection.request("POST" if payload is not None else "GET", path,
                           body=json.dumps(payload) if payload is not None else None,
                           headers={"Content-Type": "application/json"})
        response = connection.getresponse()
        if response.status not in (200, 201):
            raise OSError("Docker Engine operation failed")
        body = response.read()
        return json.loads(body) if body else None
    finally:
        connection.close()


def nginx(container, *arguments):
    execution = engine("/containers/" + container + "/exec", {"Cmd": ["nginx", *arguments]})["Id"]
    engine("/exec/" + execution + "/start", {"Detach": False, "Tty": False})
    return engine("/exec/" + execution + "/json")["ExitCode"]


def install_front(container, live_config, live_guard, config, guard):
    before = live_config.read_bytes(), live_guard.read_bytes()
    live_config.write_bytes(config)
    live_guard.write_bytes(guard)
    if nginx(container, '-t', '-q'):
        live_config.write_bytes(before[0])
        live_guard.write_bytes(before[1])
        raise RuntimeError('FRONT_CONFIG_INVALID')
    if nginx(container, '-s', 'reload'):
        raise RuntimeError('FRONT_RELOAD_FAILED')


def restore_front(release):
    state = Path(release) / '.release'
    if not (state / 'front-before.conf').exists() and not (state / 'front.json').exists():
        return False
    receipt = json.loads((state / 'front.json').read_text())
    if not receipt['changed']:
        return False
    container = receipt['container']
    mounts = {m['Destination']: m['Source'] for m in engine('/containers/' + container + '/json')['Mounts']}
    install_front(container, Path(mounts['/etc/nginx/conf.d/default.conf']), Path(mounts['/etc/paios-roaming/paios_roaming_guard.js']),
                  (state / 'front-before.conf').read_bytes(), (state / 'front-before.js').read_bytes())
    return True


def retire_newer_transport(run, target, source, services):
    """A build from before the model settings authority must not start on an authority generation: remove it
    from the Hermes homes with the newer release's own retirement, so the target composes its own transport.
    Key values are never copied or moved."""
    module = 'integrations/hermes/personal_aios/model_transport.py'
    if (Path(target) / module).exists() or not (Path(source) / module).exists():
        return False
    module = Path(source) / module
    hermes_service = next(name for name in services if name.startswith('hermes'))
    run(['run', '--rm', '--no-deps', '-T', '--pull', 'never', '--user', '10000:10000',
         '--entrypoint', '/opt/hermes/.venv/bin/python', '-v', f'{module}:/opt/paios-retire/model_transport.py:ro',
         hermes_service, '/opt/paios-retire/model_transport.py', 'retire',
         '/opt/data/config.yaml', '/opt/data/workshop/config.yaml'], capture_output=True)
    return True


class Platform:
    def __init__(self, root):
        self.root, self.lock = root, None
        self.http = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    engine = staticmethod(engine)

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
        from release_migrations import projection, project_rollback
        if projection(record['candidate_release']):
            from types import SimpleNamespace
            import release_compose
            profiles = record.get('profiles', [record['profile']])
            environment = {key: value for key, value in os.environ.items() if not key.startswith('PAIOS_')}
            def runner(selected):
                prefix = release_compose.command(selected, record['project'], profiles, executable=('docker-compose',))
                return lambda args, **options: subprocess.run(prefix + args, check=True, env=environment, **options)
            host = SimpleNamespace(config={'profiles': profiles}, suffix='-staging' if record['profile'] == 'staging' else '',
                                   runner=runner, definition=lambda selected: json.loads(runner(selected)(
                                       ['config', '--format', 'json'], capture_output=True, text=True).stdout))
            receipt = {}
            try:
                release_compose.stop_writers(host, runner(record['candidate_release']), stop_transport=False)
                project_rollback(host, record['candidate_release'], record['previous_release'], receipt)
            finally:
                atomic_json(Path(record['candidate_release']) / '.release/watchdog-memory-projection.json', receipt)
        restore_front(record["candidate_release"])
        point(record["root"], "current", record["previous_release"])
        point(record["root"], "previous", record["candidate_release"])
        files = release_files(record["previous_release"])
        compose = ["docker-compose", "-p", record["project"], "--project-directory", str(Path(files["compose"]).parent),
                   "--env-file", files["env_file"], "--env-file", files["public_env_file"], "-f", record["previous_compose"],
                   "--profile", record["profile"]]
        environment = {key: value for key, value in os.environ.items() if not key.startswith("PAIOS_")}
        retire_newer_transport(lambda args, **options: subprocess.run(compose + args, check=True, env=environment, **options),
                               record["previous_release"], record["candidate_release"],
                               [item["service"] for item in record["services"]])
        command = compose + ["up", "-d", "--no-deps", "--no-build", "--pull", "never",
                             *[item["service"] for item in record["services"]]]
        # Replace Python and invoke Compose directly, so only Compose remains resident for the image switch.
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

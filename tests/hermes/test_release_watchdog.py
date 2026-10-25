"""Release decisions with a fake Docker boundary and clock; no daemon or host writes."""
import copy
import contextlib
import io
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import MagicMock, patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "deploy/cloud"))
import release_watchdog as watchdog
from watchdog_platform import Platform
import watchdog_platform


def record():
    return {"schema": 2, "release_id": "drill-1", "project": "paios", "profile": "production",
            "root": "/srv/paios", "candidate_release": "/srv/paios/releases/cand", "previous_release": "/srv/paios/releases/prev",
            "previous_compose": "/srv/paios/releases/prev/.release/watchdog-drill-1.compose.json", "previous_compose_sha256": "0" * 64,
            "owner": {"principal_id": "owner", "device_id": "phone"},
            "services": [{"service": "gateway", "variable": "PAIOS_GATEWAY_IMAGE", "candidate": "sha256:" + "a" * 64, "previous": "sha256:" + "b" * 64}],
            "timing": {"poll_seconds": 1, "unhealthy_seconds": 10, "restart_window_seconds": 20, "restart_limit": 3,
                       "healthy_seconds": 3, "rollback_timeout_seconds": 30, "probe_timeout_seconds": 1}}


class FakeDocker:
    def __init__(self):
        self.rows = {"gateway": {"id": "candidate", "image": record()["services"][0]["candidate"], "restarts": 0}}
        self.healthy, self.state, self.rollbacks, self.notices, self.events = True, None, [], [], []
        self.fail_notice = False

    def observe(self, _):
        return copy.deepcopy(self.rows), self.healthy

    def save(self, _, state):
        self.state = copy.deepcopy(state)

    def event(self, _, kind, **fields):
        self.events.append(kind)

    def rollback(self, release):
        assert self.state["phase"] == "verifying"
        self.rollbacks.append(copy.deepcopy(release))

    def notify(self, release, _):
        if self.fail_notice:
            raise OSError("gateway notification unavailable")
        self.notices.append(release["release_id"])


class Decisions(unittest.TestCase):
    def setUp(self):
        self.docker, self.time, self.release = FakeDocker(), 0, record()
        self.watch = self.new_watch()

    def new_watch(self):
        return watchdog.Watchdog(self.docker, lambda: self.time, lambda: self.time)

    def tick(self, seconds=0):
        self.time += seconds
        return self.watch.tick(self.release, copy.deepcopy(self.docker.state))

    def trigger_failure(self):
        self.docker.healthy = False
        self.tick()
        self.tick(10)

    def test_continuous_unhealthy_window_resets_on_healthy(self):
        self.docker.healthy = False
        self.tick()
        self.tick(9)
        self.assertEqual(self.docker.rollbacks, [])
        self.docker.healthy = True
        self.tick()
        self.docker.healthy = False
        self.tick()
        self.tick(9)
        self.assertEqual(self.docker.rollbacks, [])
        self.tick(1)
        self.assertEqual(len(self.docker.rollbacks), 1)

    def test_once_per_release_survives_watchdog_restart_and_failure(self):
        self.trigger_failure()
        self.watch = self.new_watch()
        self.tick(31)
        self.tick(100)
        self.assertEqual(len(self.docker.rollbacks), 1)
        self.assertEqual(self.docker.state["phase"], "failed")
        self.assertEqual(self.docker.events.count("rollback_unhealthy"), 1)
        self.assertEqual(self.docker.notices, [])

    def test_never_roll_forward_or_overwrite_a_manual_release(self):
        self.docker.rows["gateway"]["image"] = self.release["services"][0]["previous"]
        self.trigger_failure()
        self.assertEqual(self.docker.rollbacks, [])
        self.docker.rows["gateway"]["image"] = "sha256:" + "c" * 64
        self.tick(100)
        self.assertEqual(self.docker.rollbacks, [])

    def test_waits_for_actual_previous_image_and_stable_health_then_notifies_once(self):
        self.trigger_failure()
        self.docker.healthy = True
        self.tick(3)  # Healthy candidate is not proof of rollback.
        self.assertEqual(self.docker.notices, [])
        self.docker.rows["gateway"].update(id="previous", image=self.release["services"][0]["previous"])
        self.tick()
        self.tick(1)
        self.tick(2)
        self.assertEqual(self.docker.notices, [])
        self.tick(1)
        self.assertEqual(self.docker.notices, ["drill-1"])
        self.watch = self.new_watch()
        self.tick(100)
        self.assertEqual(len(self.docker.rollbacks), 1)
        self.assertEqual(len(self.docker.notices), 1)

    def test_restart_storm_even_when_health_briefly_recovers(self):
        self.tick()
        for _ in range(3):
            self.docker.rows["gateway"]["restarts"] += 1
            self.tick(2)
        self.assertEqual(self.docker.state["reason"], "restart_storm")
        self.assertEqual(len(self.docker.rollbacks), 1)

    def test_old_restarts_expire_and_new_release_has_its_own_attempt(self):
        self.tick()
        for _ in range(3):
            self.docker.rows["gateway"]["restarts"] += 1
            self.tick(21)
        self.assertEqual(self.docker.rollbacks, [])
        self.trigger_failure()
        self.docker.state = None  # A distinct durable state file for the next release.
        self.release["release_id"] = "drill-2"
        self.trigger_failure()
        self.assertEqual(len(self.docker.rollbacks), 2)

    def test_notification_failure_does_not_repeat_rollback(self):
        self.trigger_failure()
        self.watch = self.new_watch()
        self.docker.rows["gateway"]["image"] = self.release["services"][0]["previous"]
        self.docker.healthy, self.docker.fail_notice = True, True
        self.tick()
        with self.assertRaises(OSError):
            self.tick(3)
        self.docker.fail_notice = False
        self.tick()
        self.assertEqual(len(self.docker.rollbacks), 1)
        self.assertEqual(len(self.docker.notices), 1)

    def test_release_identity_cannot_be_reused(self):
        self.trigger_failure()
        self.release["services"][0]["previous"] = "sha256:" + "c" * 64
        with self.assertRaises(ValueError):
            self.tick()

    def test_contract_rejects_mutable_tags_and_stateful_unit(self):
        watchdog.validate(self.release)
        for key, value in (("previous", "image:latest"), ("service", "postgres")):
            invalid = copy.deepcopy(self.release)
            invalid["services"][0][key] = value
            with self.assertRaises(ValueError):
                watchdog.validate(invalid)
        for key, value in (("previous_release", "/srv/paios/releases/cand"), ("root", "relative"), ("schema", 1),
                           ("previous_compose", "/srv/paios/releases/cand/.release/watchdog-drill-1.compose.json"),
                           ("previous_compose_sha256", "not-a-digest")):
            with self.assertRaises(ValueError):
                watchdog.validate({**self.release, key: value})


class ComposeSwitch(unittest.TestCase):
    def test_unchanged_front_receipt_ignores_backups_from_a_previous_attempt(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for name in ("cand", "prev"):
                state = root / "releases" / name / ".release"
                state.mkdir(parents=True)
                (state / "env").write_text("")
            state = root / "releases/cand/.release"
            (state / "front-before.conf").write_text("stale front backup")
            (state / "front-before.js").write_text("stale guard backup")
            (state / "front.json").write_text(json.dumps({"changed": False}))
            os.symlink("releases/cand", root / "current")
            os.symlink("releases/prev", root / "previous")
            release = {**record(), "root": str(root), "candidate_release": str(root / "releases/cand"),
                       "previous_release": str(root / "releases/prev")}
            platform = Platform(root)
            with (root / "release.lock").open("a") as lock, patch.object(watchdog_platform, "engine") as engine, \
                    patch("os.execvpe") as execute:
                platform.lock = lock
                platform.rollback(release)
            engine.assert_not_called()
            execute.assert_called_once()
            self.assertEqual((root / "current").resolve(), (root / "releases/prev").resolve())
            (state / "front.json").write_text(json.dumps({"changed": True, "container": "front-instance"}))
            (state / "front-before.conf").unlink()
            mounts = [{"Destination": "/etc/nginx/conf.d/default.conf", "Source": str(root / "front.conf")},
                      {"Destination": "/etc/paios-roaming/paios_roaming_guard.js", "Source": str(root / "front.js")}]
            with patch.object(watchdog_platform, "engine", return_value={"Mounts": mounts}), \
                    patch("os.execvpe") as execute, self.assertRaises(FileNotFoundError):
                platform.rollback(release)
            execute.assert_not_called()

    def test_automatic_rollback_restores_reviewed_front_before_switching_images(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            candidate, previous = root / "releases/cand", root / "releases/prev"
            for directory in (candidate, previous):
                (directory / ".release").mkdir(parents=True)
                (directory / ".release/env").write_text("")
            os.symlink("releases/cand", root / "current")
            os.symlink("releases/prev", root / "previous")
            config, guard = root / "front.conf", root / "front.js"
            config.write_text("candidate front")
            guard.write_text("candidate guard")
            state = candidate / ".release"
            (state / "front-before.conf").write_text("previous front")
            (state / "front-before.js").write_text("previous guard")
            (state / "front.json").write_text(json.dumps({"changed": True, "container": "front-instance"}))
            release = {**record(), "root": str(root), "candidate_release": str(candidate), "previous_release": str(previous)}
            mounts = [{"Destination": "/etc/nginx/conf.d/default.conf", "Source": str(config)},
                      {"Destination": "/etc/paios-roaming/paios_roaming_guard.js", "Source": str(guard)}]
            commands = []
            def docker(path, payload=None):
                commands.append((path, payload))
                if path == "/containers/front-instance/json":
                    return {"Mounts": mounts}
                self.assertEqual(config.read_text(), "previous front")
                self.assertEqual(guard.read_text(), "previous guard")
                if path == "/containers/front-instance/exec":
                    return {"Id": "nginx-exec"}
                if path.endswith("/json"):
                    return {"ExitCode": 0}
            def compose(*args):
                self.assertEqual(config.read_text(), "previous front")
                self.assertEqual(guard.read_text(), "previous guard")
                self.assertEqual((root / "current").resolve(), previous.resolve())
            platform = Platform(root)
            with (root / "release.lock").open("a") as lock, patch.object(watchdog_platform, "engine", side_effect=docker), \
                    patch("os.execvpe", side_effect=compose):
                platform.lock = lock
                platform.rollback(release)
            self.assertEqual(commands, [("/containers/front-instance/json", None),
                ("/containers/front-instance/exec", {"Cmd": ["nginx", "-t", "-q"]}),
                ("/exec/nginx-exec/start", {"Detach": False, "Tty": False}), ("/exec/nginx-exec/json", None),
                ("/containers/front-instance/exec", {"Cmd": ["nginx", "-s", "reload"]}),
                ("/exec/nginx-exec/start", {"Detach": False, "Tty": False}), ("/exec/nginx-exec/json", None)])

    def test_previous_container_with_starting_health_is_not_ready(self):
        with tempfile.TemporaryDirectory() as temporary:
            platform = Platform(Path(temporary))
            response = MagicMock()
            response.__enter__.return_value.status = 200
            for health, expected in (({"Status": "starting"}, False), ({"Status": "unhealthy"}, False), ({"Status": "healthy"}, True), (None, True)):
                state = {"Running": True, **({"Health": health} if health else {})}
                inspection = {"Id": "container", "Image": record()["services"][0]["previous"], "RestartCount": 0, "State": state}
                listing = [{"Id": "container", "Labels": {"com.docker.compose.service": "gateway"}}]
                with patch.object(platform, "engine", side_effect=[listing, inspection]), patch.object(platform.http, "open", return_value=response):
                    self.assertEqual(platform.observe(record())[1], expected)

    def test_release_script_captures_running_image_before_switch_then_arms_atomically(self):
        spec = importlib.util.spec_from_file_location("producer", ROOT / "deploy/cloud/watchdog-record.py")
        producer = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(producer)
        previous = os.umask(0o077)
        os.umask(previous)
        self.addCleanup(os.umask, previous)
        for names in (("gateway",), ("gateway", "hermes", "workshop", "workshop-link")):
            variables = dict(zip(names, ("PAIOS_GATEWAY_IMAGE", "PAIOS_HERMES_IMAGE", "PAIOS_WORKSHOP_IMAGE", "PAIOS_WORKSHOP_IMAGE")))
            candidate = dict(zip(names, ("sha256:" + c * 64 for c in "acdd")))
            prior = dict(zip(names, ("sha256:" + c * 64 for c in "beff")))
            switched, previous_pin, calls, previous_text = False, prior["gateway"], [], []
            broken_link_control = False
            def docker(command, **options):
                if command[1] == "compose":
                    self.assertTrue(any(item.endswith("/compose.workshop-client.yaml") for item in command))
                    self.assertEqual(command[-len(names):], list(names))
                    env_file = command[command.index("--env-file") + 1]
                    is_previous = "/prev/" in env_file
                    images = {**prior, "gateway": previous_pin} if is_previous else candidate
                    model = {"services": {name: {"image": options["env"].get(variables[name], images[name])} for name in names},
                             "volumes": {"owner": {"name": "paios_owner"}}}
                    if broken_link_control:
                        model["services"]["workshop-link"]["image"] = images["workshop-link"]
                    model["services"].update(front={"image": "front"}, postgres={"image": "postgres"})
                    model["services"]["gateway"].update(network_mode="service:front", depends_on={"postgres": {"condition": "service_healthy"}},
                        volumes=[{"type": "volume", "source": "owner", "target": "/data"}],
                        environment={"LITERAL": "$$dollar", "PAIOS_BUILDER_URL": "https://builder.invalid"})
                    raw = json.dumps(model, indent=1) + "\n"
                    calls.append((env_file, options["env"]))
                    if is_previous: previous_text.append(raw)
                    return raw
                if command[1] == "ps":
                    return "running-" + command[-1].rsplit("=", 1)[1] + "\n"
                if command[1] == "image":
                    return json.dumps([{"Id": command[-1]}])
                if command[1] == "container":
                    return json.dumps([{"Image": (candidate if switched else prior)[command[-1].removeprefix("running-")]}])
                raise AssertionError(command)
            with tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                timing = root / "timing.json"
                timing.write_text(json.dumps(record()["timing"]))
                for name in ("cand", "prev"):
                    state = root / "releases" / name / ".release"
                    state.mkdir(parents=True)
                    (state / "env").write_text("PAIOS_BUILDER_URL=https://builder.invalid\n")
                with (root / "release.lock").open("a") as lock:
                    args = ["producer", "--lock-fd", str(lock.fileno()), "--state-dir", str(root), "--release-id", "drill-1",
                            "--project", "paios", "--profile", "production", "--root", str(root),
                            "--candidate-release", str(root / "releases/cand"), "--previous-release", str(root / "releases/prev"),
                            "--timing", str(timing), "--principal-id", "owner", "--device-id", "phone"]
                    args += [arg for name in names for arg in ("--unit", name + ":" + variables[name])]
                    with patch("subprocess.check_output", side_effect=docker), contextlib.redirect_stdout(io.StringIO()):
                        with patch.object(sys, "argv", args + ["--mode", "prepare"]):
                            previous_pin = "sha256:" + "9" * 64
                            with self.assertRaises(ValueError): producer.main()
                            previous_pin = prior["gateway"]
                            if "workshop-link" in names:
                                broken_link_control = True
                                with self.assertRaisesRegex(ValueError, "variable does not control"): producer.main()
                                broken_link_control = False
                            calls.clear(); previous_text.clear()
                            producer.main()
                        self.assertEqual(len(calls), 2 + len(set(variables.values())))
                        self.assertFalse((root / "release.json").exists())
                        pending = json.loads((root / "pending-drill-1.json").read_text())
                        model_file = Path(pending["previous_compose"])
                        original = model_file.read_text()
                        self.assertEqual(original, previous_text[0])  # Keep Compose's dependency graph and dollar escaping verbatim.
                        self.assertEqual(model_file.stat().st_mode & 0o777, 0o600)
                        with patch.object(sys, "argv", args + ["--mode", "arm"]):
                            model_file.write_text(original + " ")
                            with self.assertRaisesRegex(ValueError, "Compose model changed"): producer.main()
                            model_file.unlink()
                            with self.assertRaises(FileNotFoundError): producer.main()
                            model_file.write_text(original)
                            with self.assertRaisesRegex(ValueError, "running candidate"): producer.main()
                            switched = True
                            producer.main()
                            with self.assertRaises(ValueError): producer.main()
                        self.assertEqual(len(calls), 2 + len(set(variables.values())))  # Arm never re-renders.
                    saved = json.loads((root / "release.json").read_text())
                    self.assertEqual(saved, pending)
                    self.assertEqual([item["service"] for item in saved["services"]], list(names))
                    self.assertEqual([(item["candidate"], item["previous"]) for item in saved["services"]], [(candidate[n], prior[n]) for n in names])

    def test_rollback_swaps_pointers_and_executes_the_previous_release_without_python_resident(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for name in ("cand", "prev"):
                (root / "releases" / name / ".release").mkdir(parents=True)
                (root / "releases" / name / ".release/env").write_text("PAIOS_BUILDER_URL=https://builder.invalid\n")
            os.symlink("releases/cand", root / "current")
            os.symlink("releases/prev", root / "previous")
            release = {**record(), "root": str(root), "candidate_release": str(root / "releases/cand"),
                       "previous_release": str(root / "releases/prev"),
                       "previous_compose": str(root / "releases/prev/.release/watchdog-drill-1.compose.json")}
            names = ("gateway", "hermes", "workshop", "workshop-link")
            release["services"] = [{**release["services"][0], "service": name} for name in names]
            platform = Platform(root)
            go_environment = {"GOMEMLIMIT": "4MiB", "GOGC": "10", "GOMAXPROCS": "1", "COMPOSE_PARALLEL_LIMIT": "1"}
            with (root / "release.lock").open("a") as lock, patch("os.execvpe") as execute, \
                    patch.dict(os.environ, {**go_environment, "PAIOS_GATEWAY_IMAGE": "stale", "PAIOS_GATEWAY_PORT": "8787"}):
                platform.lock = lock
                platform.rollback(release)
                command = execute.call_args.args[1]
                self.assertEqual((root / "current").resolve(), (root / "releases/prev").resolve())
                self.assertEqual((root / "previous").resolve(), (root / "releases/cand").resolve())
                self.assertIn(str(root / "releases/prev/.release/env"), command)
                self.assertEqual(command[command.index("--project-directory") + 1], str(root / "releases/prev/deploy/cloud"))
                self.assertEqual(command[command.index("-f") + 1], release["previous_compose"])
                self.assertEqual(command.count("-f"), 1)
                self.assertIn(str(root / "releases/prev/deploy/cloud/.build/production.public.env"), command)
                self.assertEqual(command[command.index("up"):], ["up", "-d", "--no-deps", "--no-build", "--pull", "never", *names])
                self.assertEqual(command[command.index("-p") + 1], release["project"])
                self.assertTrue(os.get_inheritable(lock.fileno()))
                self.assertFalse(any(key.startswith("PAIOS_") for key in execute.call_args.args[2]))
                self.assertEqual({key: execute.call_args.args[2][key] for key in go_environment}, go_environment)

if __name__ == "__main__":
    unittest.main()

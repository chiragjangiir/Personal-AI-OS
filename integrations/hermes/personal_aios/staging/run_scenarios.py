"""Scenario runner for the staging Hermes (start it with mac-product/bin/start-hermes-staging.sh).

Each scenario is a list of user turns sent as production-shaped D events (typed text with the iPhone fix) to one
fresh staging session, with the main skill as instructions, the way the gateway runs it. Legacy scenarios disable
memory writes. --commute uses a private home with native learning and formal RTC/place admission; no owner sessions.
Payment: --payment <worktree/.scratch/private-root> [payment-typed-order payment-no-card payment-settings].
The root contains hermes-staging/{gateway.json,config.yaml} from the existing staging launcher,
plus payment-scenarios.json: integration_base_url, device_key_file,
state_db, run_timeout_s, request_timeout_s, poll_s. Use a paired fixture phone key issued by isolated staging. Paths must resolve inside that private root.
Legacy scenarios require PAIOS_SCENARIO_ROOT pointing to the same private root.
Uses the staging home's existing model configuration; does not start services or modify config.
Usage: run_scenarios.py [name ...] | --commute <private-root> chat <turn ...> | transition <region> <kind> | cron <job>"""

from __future__ import annotations

import datetime
from contextlib import closing
import json
import os
import subprocess
import re
import sqlite3
from pathlib import Path
import sys
import time
import urllib.request
import uuid

BASE = ""
KEY = ""
SKILL = ""
REQUEST_TIMEOUT_S = 900
PHONE_LOG = ""
FIX = {"latitude": 31.2397, "longitude": 121.4998, "accuracy_m": 12, "datum": "wgs84", "place": "上海市陆家嘴（公开地标）"}

SCENARIOS = {
    "ride-price": ["打车去杭州东站要多少钱"],
    "ride-call-cancel": ["帮我叫个车去杭州东站", "算了不要了，取消吧"],
    "food-progress": ["帮我点一杯示例茶饮店的示例茶饮，中杯常温无糖", "点好了吗"],
    "wechat-send": ["给小林发微信，说我今晚晚点到"],
    "wechat-help-reply": ["帮我回一下小林的微信"],
    "wechat-mac": ["用电脑给小林发个微信说收到"],
    "wechat-inbox": ["看看微信谁找我了"],
    "stop-errand": ["帮我点一杯示例茶饮店的示例茶饮中杯常温无糖", "等等，别点了"],
}


PAYMENT_SCENARIOS = {
    "payment-typed-order": ["帮我点一杯示例茶饮店的示例茶饮"],
    "payment-no-card": ["付吧"],
    "payment-settings": ["开免密"],
}


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise RuntimeError("Staging redirects are forbidden")


def _isolated_opener():
    return urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect())


def _loopback(url):
    from urllib.parse import urlsplit
    endpoint = urlsplit(url)
    if (endpoint.scheme != "http" or endpoint.hostname != "127.0.0.1" or not endpoint.port
            or endpoint.username or endpoint.password or endpoint.path or endpoint.query or endpoint.fragment):
        raise ValueError("Use a direct numeric-loopback staging origin")
    return endpoint.port


def _listener(url):
    """Inspect OS ownership, never trust a service's self-reported staging identity."""
    import psutil
    port = _loopback(url)
    result = subprocess.run(["/usr/sbin/lsof", "-nP", f"-iTCP:{port}", "-sTCP:LISTEN", "-Fp"],
                            check=True, capture_output=True, text=True)
    pids = {int(line[1:]) for line in result.stdout.splitlines() if line.startswith("p")}
    if len(pids) != 1:
        raise ValueError("Staging listener must have one owned process")
    process = psutil.Process(pids.pop())
    if process.uids().real != os.getuid():
        raise ValueError("Staging listener is not owned by this user")
    # A wildcard listener can expose fixture credentials outside the private host.
    sockets = process.net_connections(kind="tcp")
    if not any(c.status == "LISTEN" and c.laddr.port == port for c in sockets) or any(
            c.status == "LISTEN" and c.laddr.port == port and c.laddr.ip != "127.0.0.1" for c in sockets):
        raise ValueError("Staging listener must bind only numeric loopback")
    return process


class StagingBinding:
    """Bind the existing launcher/configuration to owned live processes, before sending credentials."""
    def __init__(self, root):
        import yaml
        self.private = Path(root).resolve()
        workspace = Path(__file__).resolve().parents[4]
        if not self.private.is_relative_to(workspace / ".scratch"):
            raise ValueError("Use a private worktree staging root")
        self.home = self.local(self.private / "hermes-staging")
        self.config_file = self.local(self.home / "config.yaml")
        self.gateway_file = self.local(self.home / "gateway.json")
        native = yaml.safe_load(self.config_file.read_text())
        self.gateway = json.loads(self.gateway_file.read_text())
        gateway = self.gateway
        self.base = gateway["hermes_base_url"]
        self.authority = f'http://127.0.0.1:{gateway["port"]}'
        self.gateway_base = f'http://127.0.0.1:{gateway["product_resources"]["gateway_port"]}'
        for field in ("storage_root", "lock_file", "hermes_key_file", "internal_key_file"):
            self.local(gateway[field])
        policy = gateway["payment"]
        if policy.get("enabled") is not True or policy.get("staging") is not True:
            raise ValueError("A staging payment authority is required")
        executor_key = self.local(policy["executor_key_file"])
        self.key = self.local(gateway["hermes_key_file"]).read_text().strip()
        internal_key = self.local(gateway["internal_key_file"])
        if len({self.key, internal_key.read_text().strip(), executor_key.read_text().strip()}) != 3 or not self.key:
            raise ValueError("Isolated staging keys must be separate")
        personal = native["personal_aios"]
        if personal["internal_base_url"] != self.authority or self.local(personal["internal_key_file"]) != internal_key:
            raise ValueError("Hermes must use the bound staging authority")
        phone = native["mcp_servers"]["phone"]
        expected = Path(__file__).with_name("fake_phone.py").resolve()
        if phone.get("args") != [str(expected)] or "url" in phone:
            raise ValueError("Only this checkout's fake_phone.py is permitted")
        env = phone["env"]
        self.phone_log = self.local(env["PAIOS_FAKE_PHONE_LOG"])
        self.spool = self.local(env["PAIOS_ERRAND_SPOOL"])
        self.local(env["PAIOS_FAKE_CASHIER"])
        if env["PAIOS_PAYMENT_URL"] != self.authority or self.local(env["PAIOS_PAYMENT_KEY_FILE"]) != executor_key:
            raise ValueError("Fake phone must use the bound staging payment authority")
        authority = _listener(self.authority)
        if _listener(self.gateway_base).pid != authority.pid:
            raise ValueError("Gateway and payment authority must share the existing product process")
        hermes = _listener(self.base)
        commands = authority.cmdline()
        source = workspace / "01-product-half-finished/backend"
        entries = {str(source / "services/personal-aios-integration/src/main.ts"),
                   str(source / "phase0/gateway/src/rayneo-persistent-production-entrypoint.ts")}
        if (len(commands) < 2 or Path(commands[0]).name != "node" or commands[1] not in entries
                or "--config" not in commands or Path(
                commands[commands.index("--config") + 1]).resolve() != self.gateway_file):
            raise ValueError("Authority must run the checkout's existing --config entry point")
        if hermes.cmdline()[1:2] != [str(workspace / "integrations/hermes/personal_aios/run_api.py")]:
            raise ValueError("Hermes must run this checkout's staging entry point")
        if Path(phone["command"]).resolve() != Path(hermes.cmdline()[0]).resolve():
            raise ValueError("Fake phone must use the owned Hermes interpreter")
        self.processes = [(authority, authority.create_time(), (self.gateway_file,)),
                          (hermes, hermes.create_time(), (self.config_file, self.gateway_file))]
        for process, started, config_paths in self.processes:
            process_env = process.environ()
            if process_env.get("PAIOS_STAGE") != "staging":
                raise ValueError("Listener process is not staging")
            for config_path in config_paths:
                if config_path.stat().st_mtime > started:
                    raise ValueError("Staging config changed after process start; restart staging")
        env = hermes.environ()
        if Path(env.get("HERMES_HOME", "")).resolve() != self.home or Path(
                env.get("PAIOS_PRODUCT_CONFIG", "")).resolve() != self.gateway_file:
            raise ValueError("Live Hermes profile does not match staging config")
        self.opener = _isolated_opener()

    def local(self, value):
        path = Path(value).resolve()
        if not path.is_relative_to(self.private):
            raise ValueError("Fixture state and keys must stay in the private staging root")
        return path

    def open(self, request, timeout):
        from urllib.parse import urlsplit
        endpoint = urlsplit(request.full_url)
        if f"{endpoint.scheme}://{endpoint.netloc}" not in (self.base, self.authority, self.gateway_base):
            raise ValueError("Request is outside bound staging listeners")
        for process, started, config_paths in self.processes:
            if not process.is_running() or process.create_time() != started:
                raise ValueError("Bound staging process exited")
            if any(p.stat().st_mtime > started for p in config_paths):
                raise ValueError("Bound staging config changed")
        return self.opener.open(request, timeout=timeout)


BINDING = None

def assert_payment_scenario(name: str, calls: list[dict], output: str, fake_calls: list[dict] | None = None) -> None:
    """Assert native tool-call traces, including request receipt -> dispatch lineage."""
    assert not any("pay_limit_yuan" in c["args"] for c in calls), "removed payment argument"
    if name == "payment-typed-order":
        requested = [(i, c) for i, c in enumerate(calls) if c["tool"] == "paios_payment" and c["args"].get("action") == "request"]
        phones = [(i, c) for i, c in enumerate(calls) if c["tool"] in ("phone_task", "mcp__phone__phone_task")]
        assert requested and phones, "expected payment request and phone dispatch"
        i, request = requested[0]
        receipt = request["result"]
        assert receipt["status"] == "accepted" and receipt["intent_id"], receipt
        assert all(j > i and c["args"].get("payment_intent") == receipt["intent_id"] for j, c in phones), phones
        for _, phone in phones:
            assert phone["args"].get("app"), "Phone dispatch requires the requested app"
            if request["args"].get("app") is not None:
                assert phone["args"]["app"] == request["args"]["app"], "Payment request app differs from dispatch"
            dispatched = phone["result"] or {}
            assert dispatched.get("status") == "started" and dispatched.get("job_id"), dispatched
            job_id = dispatched["job_id"]
            matches = [c for c in fake_calls or [] if c["args"].get("payment_intent") == receipt["intent_id"]
                       and c["args"].get("app") == phone["args"].get("app")]
            assert any(c["tool"] == "phone_task" and (c.get("result") or {}).get("job_id") == job_id
                       and c["result"].get("status") == "started" for c in matches), matches
            assert any(c["tool"] == "payment_checkpoint" and c["args"].get("job_id") == job_id
                       and (c.get("result") or {}).get("checkpoint_reached") is True for c in matches), matches
    elif name == "payment-no-card":
        assert not any(c["tool"] in ("phone_task", "mcp__phone__phone_task") or
                       c["tool"] == "paios_payment" and c["args"].get("action") == "request" for c in calls), calls
        assert not re.search(r"(?<!没)(?<!未)(?:已付款|已支付|付好了|已经付了|付款成功|支付成功|付款完成|我帮你付了)", output), output
    elif name == "payment-settings":
        # Main-skill rule 11 requires this metadata tool even for a plain spoken/text reply.
        assert all(c["tool"] == "paios_open_reply" for c in calls), "settings request must only route its reply"
        assert "设置" in output and "支付与安全" in output and ("iPhone" in output or "手机" in output), output
    else:
        raise ValueError(name)


def _payment_trace(database: Path, session: str) -> list[dict]:
    with closing(sqlite3.connect(database.as_uri() + "?mode=ro", uri=True)) as db:
        rows = db.execute("SELECT role,content,tool_call_id,tool_calls FROM messages WHERE session_id=? ORDER BY id", (session,)).fetchall()
    calls, by_id = [], {}
    for role, content, call_id, tool_calls in rows:
        for entry in json.loads(tool_calls or "[]"):
            function = entry["function"]
            item = {"tool": function["name"], "args": json.loads(function["arguments"]), "result": None}
            calls.append(item)
            by_id[entry["id"]] = item
        if role == "tool" and call_id in by_id:
            by_id[call_id]["result"] = json.loads(content)
    return calls


def _payment_turn(binding: StagingBinding, device_key: str, session: str, text: str, config: dict) -> dict:
    """Use INT source admission; only the server constructs D and the owner-scoped run."""
    from urllib.error import HTTPError
    from urllib.parse import quote, urlencode
    def request(path, body=None):
        req = urllib.request.Request(binding.authority + path, data=None if body is None else json.dumps(body).encode(),
            headers={"Authorization": "Bearer " + device_key, "Content-Type": "application/json"})
        with binding.open(req, timeout=config["request_timeout_s"]) as response:
            return json.load(response)
    accepted = request("/v1/prompts", {"event_id": "payment-scenario-" + uuid.uuid4().hex,
        "captured_at": now(), "text": text, "session_id": session})
    d, admission = accepted["processed_event"], accepted["admission"]
    assert d["origin"] == "explicit_user_prompt" and d["device_type"] == "phone" and d["content"]["text"] == text, d
    path = "/v1/events/" + quote(d["processed_event_id"], safe="") + "/result?" + urlencode({"session_id": session})
    deadline = time.monotonic() + config["run_timeout_s"]
    while time.monotonic() < deadline:
        try:
            result = request(path)["result"]
            assert result["schema_version"] == "paios.result.v1" and result["result_status"] == "completed", result
            assert result["session_id"] == session and result["processed_event_id"] == d["processed_event_id"], result
            assert result["run_id"] == admission["run_id"], result
            return {"accepted": accepted, "result": result}
        except HTTPError as exc:
            error = json.load(exc)
            if exc.code != 409 or error.get("error_code") not in {"RUN_NOT_ACCEPTED", "OUTPUT_NATIVE_NOT_TERMINAL"}:
                raise
        time.sleep(config["poll_s"])
    raise TimeoutError("Staging admitted run did not complete within configured timeout")


def payment(root: str, *names: str) -> None:
    """Explicit isolated staging configuration only; never inherit runtime paths or model settings."""
    binding = StagingBinding(root)
    private = binding.private
    config = json.loads((private / "payment-scenarios.json").read_text())
    if config["integration_base_url"] != binding.authority:
        raise ValueError("Payment scenario endpoint differs from staging authority")
    assert all(config[key] > 0 for key in ("run_timeout_s", "request_timeout_s", "poll_s"))
    device_key = binding.local(config["device_key_file"]).read_text().strip()
    database = binding.local(config["state_db"])
    if database != binding.home / "state.db":
        raise ValueError("Read native traces only from the bound Hermes state.db")
    for name in names or PAYMENT_SCENARIOS:
        mark = len(binding.phone_log.read_text().splitlines()) if binding.phone_log.exists() else 0
        session = f"staging-{name}-{uuid.uuid4().hex[:8]}"
        lineage = _payment_turn(binding, device_key, session, PAYMENT_SCENARIOS[name][0], config)
        result = lineage["result"]
        calls = _payment_trace(database, session)
        deadline = time.monotonic() + config["run_timeout_s"]
        while True:
            fake_calls = [json.loads(line) for line in binding.phone_log.read_text().splitlines()[mark:]] if binding.phone_log.exists() else []
            job_ids = {(c.get("result") or {}).get("job_id") for c in calls if c["tool"] in ("phone_task", "mcp__phone__phone_task")}
            if name != "payment-typed-order" or any(c["tool"] == "payment_checkpoint" and c["args"].get("job_id") in job_ids for c in fake_calls):
                break
            if time.monotonic() >= deadline:
                raise TimeoutError("Fake payment checkpoint evidence did not arrive")
            time.sleep(config["poll_s"])
        assert_payment_scenario(name, calls, result["reply_text"], fake_calls)
        report = {"scenario": name, "status": "passed", "run_id": result["run_id"], "lineage": lineage,
                  "session_id": session, "calls": calls, "fake_calls": fake_calls, "output": result["reply_text"], "synthetic_fixture": True,
                  "real_world_claim": False}
        (private / f"{name}-result.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
        print(json.dumps(report, ensure_ascii=False))


def assert_recovery_trace(events: list[dict], outcome: str) -> None:
    """Assert physical continuation and original-order lineage, not model wording."""
    phones = [e for e in events if e["tool"] == "phone_task"]
    checkpoints = [e for e in events if e["tool"] == "payment_checkpoint"]
    reconciles = [e for e in events if e["tool"] == "payment_reconcile"]
    assert len(reconciles) == 1 and len(checkpoints) in (1, 2), events
    read = reconciles[0]
    dispatch = next(e for e in phones if e["result"]["job_id"] == read["args"]["job_id"])
    assert dispatch["args"]["payment_intent"] is None
    assert dispatch["args"]["goal"].startswith("从当前页面继续：")
    assert read["result"]["taps"] == 1
    original = checkpoints[0]
    assert original["result"]["success"] is False and original["result"]["taps"] == 1
    assert read["result"]["order_id"] == original["result"]["order_id"]
    if len(checkpoints) == 2:
        recovery = checkpoints[1]
        assert read["result"]["state"] == "unpaid"
        assert recovery["args"]["payment_intent"] != original["args"]["payment_intent"]
        resumed = next(e for e in phones if e["result"]["job_id"] == recovery["args"]["job_id"])
        assert resumed["args"]["goal"].startswith("从当前页面继续：")
        assert resumed["args"]["app"] == dispatch["args"]["app"] == original["args"]["app"]
        assert recovery["result"]["order_id"] == original["result"]["order_id"]
        assert recovery["result"]["taps"] == 2
        assert recovery["result"]["success"] == (outcome == "paid")
    else:
        assert read["result"]["state"] in {"paid", "unknown"}
    assert len(phones) == len(checkpoints) + 1, "No dispatch after reconciliation/second unknown"


def payment_recovery(root: str) -> None:
    """Native staging/model path. Paired isolated fixture confirms each shown card externally.

    Uses the launcher's real skill and admitted turns; never manufactures a confirmation endpoint.
    The configured cashier must return unknown first and expose its bound unpaid order on reconciliation.
    """
    binding = StagingBinding(root)
    config = json.loads((binding.private / "payment-scenarios.json").read_text())
    assert config["integration_base_url"] == binding.authority
    device_key = binding.local(config["device_key_file"]).read_text().strip()
    database = binding.local(config["state_db"])
    assert database == binding.home / "state.db"
    mark = len(binding.phone_log.read_text().splitlines()) if binding.phone_log.exists() else 0
    session = "staging-payment-recovery-" + uuid.uuid4().hex[:8]
    lineage = [_payment_turn(binding, device_key, session, "付吧", config)]
    assert_payment_scenario("payment-no-card", _payment_trace(database, session), lineage[-1]["result"]["reply_text"], [])
    lineage.append(_payment_turn(binding, device_key, session, "帮我点一杯示例茶饮店的示例茶饮", config))
    def wait_event(tool, count):
        deadline = time.monotonic() + config["run_timeout_s"]
        while time.monotonic() < deadline:
            lines = binding.phone_log.read_text().splitlines()[mark:] if binding.phone_log.exists() else []
            events = [json.loads(line) for line in lines]
            if sum(e["tool"] == tool for e in events) >= count:
                return events
            time.sleep(config["poll_s"])
        raise TimeoutError("Recovery stage incomplete: " + tool + "; shown cards need the paired isolated fixture confirmation")
    events = wait_event("payment_reconcile", 1)
    read = next(e["result"] for e in events if e["tool"] == "payment_reconcile")
    if read["state"] == "unpaid":
        lineage.append(_payment_turn(binding, device_key, session, "付吧", config))
        events = wait_event("payment_checkpoint", 2)
    completed = [e for e in events if e["tool"] == "payment_checkpoint"]
    outcome = "paid" if completed[-1]["result"]["success"] else "unknown"
    assert_recovery_trace(events, outcome)
    calls = _payment_trace(database, session)
    requested = [c for c in calls if c["tool"] == "paios_payment" and c["args"].get("action") == "request"]
    checkpoints = [e for e in events if e["tool"] == "payment_checkpoint"]
    assert len(requested) == len(checkpoints)
    assert [c["result"]["intent_id"] for c in requested] == [e["args"]["payment_intent"] for e in checkpoints]
    report = {"scenario": "payment-recovery", "lineage": lineage, "calls": calls, "fake_calls": events,
              "synthetic_fixture": True, "real_world_claim": False}
    (binding.private / "payment-recovery-result.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))


def now() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def call(path: str, body: dict | None = None) -> dict:
    if BINDING is None or BASE != BINDING.base:
        raise ValueError("Bind an owned fake staging instance before calling the runner")
    request = urllib.request.Request(BASE + path, data=json.dumps(body).encode() if body else None,
                                     headers={"Authorization": "Bearer " + KEY, "Content-Type": "application/json"},
                                     method="POST" if body else "GET")
    return json.load(BINDING.open(request, timeout=REQUEST_TIMEOUT_S))


def turn(session: str, text: str, timeout_s: float = 900, poll_s: float = 3) -> dict:
    d = {"schema_version": "paios.event.v1", "event_id": "scenario-" + uuid.uuid4().hex[:8], "captured_at": now(),
         "device_type": "phone", "media_type": "text", "origin": "explicit_user_prompt",
         "intent_class": "explicit_request", "reply_hint": "respond",
         "source": {"channel": "rtc_typed_text", "location": {**FIX, "observed_at": now()}}, "content": {"text": text}}
    run = call("/v1/runs", {"input": json.dumps(d, ensure_ascii=False, sort_keys=True), "instructions": SKILL,
                            "session_id": session, "memory_write": False})
    run_id = run.get("run_id") or run.get("id")
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        time.sleep(poll_s)
        status = call(f"/v1/runs/{run_id}")
        if status.get("status") not in ("queued", "running", "in_progress", "pending"):
            return status
    raise TimeoutError("Staging run did not complete within configured timeout")


def main(names: list[str]) -> None:
    global KEY, SKILL, BASE, PHONE_LOG, BINDING
    if any(name in PAYMENT_SCENARIOS for name in names):
        raise ValueError("Payment scenarios require --payment <private-root>")
    BINDING = StagingBinding(os.environ["PAIOS_SCENARIO_ROOT"])
    BASE, KEY, PHONE_LOG = BINDING.base, BINDING.key, str(BINDING.phone_log)
    from pathlib import Path
    SKILL = (Path(__file__).resolve().parents[1] / "skills/personal-aios-main/SKILL.md").read_text()
    for name in names or list(SCENARIOS):
        session = f"staging-{name}-{uuid.uuid4().hex[:6]}"
        print(f"=== {name}")
        for text in SCENARIOS[name]:
            mark = sum(1 for _ in open(PHONE_LOG)) if __import__("os").path.exists(PHONE_LOG) else 0
            started = time.time()
            status = turn(session, text)
            calls = [json.loads(line) for line in open(PHONE_LOG)][mark:] if __import__("os").path.exists(PHONE_LOG) else []
            print(f"  用户：{text}   ({time.time() - started:.0f}s, {status.get('status')})")
            for c in calls:
                args = {k: v for k, v in c["args"].items() if v not in (None, False, 80, "fast") or k == "ride_ok"}
                print(f"    → {c['tool']} {json.dumps(args, ensure_ascii=False)[:600]}")
            print(f"    依米：{(status.get('output') or status.get('error') or '')[:300]}")


def commute(root: str, step: str, *args: str) -> None:
    """Private staging chat uses the formal transport; transitions use the public place upload."""
    import subprocess
    from pathlib import Path
    from urllib.parse import urlsplit
    global BASE, KEY, BINDING
    workspace = Path(__file__).resolve().parents[4]
    BINDING = StagingBinding(root)
    root = BINDING.private
    home = root / "hermes-staging"
    config = json.loads((home / "gateway.json").read_text())
    assert config["product_resources"]["postgres"]["database"] == "paios_mac_stage_mh3"
    BASE, KEY = config["hermes_base_url"], Path(config["hermes_key_file"]).read_text().strip()
    pair = json.loads((root / "resources/iphone-pairing.v1.json").read_text())
    host = urlsplit(config["product_resources"]["livekit_url"]).netloc
    headers = {"Authorization": "Bearer " + (root / "place-token.key").read_text().strip(),
        "Content-Type": "application/json", "Host": host, "X-Forwarded-Host": host,
        "X-Forwarded-Proto": "https", "X-Forwarded-For": "127.0.0.1", "X-Paios-Trusted-Edge": "tencent-nginx-loopback-v1",
        "X-Paios-Trusted-Source-Family": "ipv4",
        "X-Paios-Proxy-Attestation": Path(config["product_resources"]["proxy_file"]).read_text().strip()}
    before = {p.name for p in (home / "storage/run-bindings").glob("*")}
    log = home / "fake-mijia.jsonl"
    mark = len(log.read_text().splitlines()) if log.exists() else 0
    chat = None
    if step == "cron":
        os.environ.update(HERMES_HOME=str(home), PAIOS_STAGE="staging")
        from cron.jobs import trigger_job
        # The running Hermes ticker claims, executes and delivers it with its real adapter.
        assert trigger_job(args[0]) is not None
    elif step in ("transition", "unconfirmed"):
        region_id, kind = args
        def upload(body):
            request = urllib.request.Request(BINDING.gateway_base + "/v1/place/upload", json.dumps(body).encode(), headers)
            with BINDING.open(request, timeout=60) as response:
                return json.load(response)
        regions = upload({"schema": "paios.place-upload.v1", "device_id": pair["device_id"], "events": []})
        region = next(r for r in regions["regions"]["items"] if r["id"] == region_id)
        sensor_at = now()
        event = {"id": "mh3-" + uuid.uuid4().hex, "kind": kind, "region_id": region_id, "sensor_at": sensor_at,
            "location": {"latitude": region["latitude"], "longitude": region["longitude"], "accuracy_m": 12,
                         "datum": "wgs84", "place": region["label"], "observed_at": sensor_at}}
        receipt = upload({"schema": "paios.place-upload.v1", "device_id": pair["device_id"], "events": [event]})
        assert receipt["stored_ids"] == [event["id"]], receipt
        print(json.dumps({"upload": receipt, "event": event}, ensure_ascii=False), flush=True)
    else:
        assert step == "chat"
        # Official virtual RTC participant; no phone and no direct Hermes create call.
        source = """
import {readFileSync} from 'node:fs'; import {createRequire} from 'node:module';
import {createInterface} from 'node:readline';
const require=createRequire(process.argv[2]); const {Room,RoomEvent,AudioSource,LocalAudioTrack,TrackSource}=require('@livekit/rtc-node');
const originalFetch=globalThis.fetch;
globalThis.fetch=(input,options={})=>originalFetch(input,{...options,redirect:'error'});
const bootstrap=JSON.parse(readFileSync(process.argv[1],'utf8')), room=new Room();
room.on(RoomEvent.DataReceived,(bytes,p,kind,topic)=>{if(topic===bootstrap.central_text_transport.output_topic)
  console.error(Buffer.from(bytes).toString('utf8'));});
await room.connect(bootstrap.livekit.server_url,bootstrap.livekit.participant_token,{autoSubscribe:false});
const publication=await room.localParticipant.publishTrack(LocalAudioTrack.createAudioTrack('mh3-virtual',new AudioSource(16000,1)),{source:TrackSource.SOURCE_MICROPHONE});
await publication.waitForSubscription();
for await (const line of createInterface({input:process.stdin}))
  await room.localParticipant.publishData(Buffer.from(JSON.stringify({operation:'submit',event_id:'mh3-'+crypto.randomUUID(),
    captured_at:new Date().toISOString(),text:JSON.parse(line)})),{reliable:true,topic:bootstrap.central_text_transport.input_topic});
await room.disconnect(); process.exit(0);
"""
        bootstrap = json.loads((root / "bootstrap.json").read_text())
        rtc_url = bootstrap["livekit"]["server_url"]
        rtc = _listener(rtc_url.replace("ws://", "http://", 1))
        rtc_command = rtc.cmdline()
        if Path(rtc_command[0]).name != "livekit-server" or "--config" not in rtc_command:
            raise ValueError("RTC must use an owned isolated LiveKit process")
        rtc_config = BINDING.local(rtc_command[rtc_command.index("--config") + 1])
        if rtc_config.stat().st_mtime > rtc.create_time():
            raise ValueError("LiveKit config changed after process start")
        if rtc_url != config["product_resources"]["livekit_url"]:
            raise ValueError("RTC bootstrap must use the owned isolated LiveKit listener")
        child_env = {k: v for k, v in os.environ.items() if k.lower() not in
                     {"http_proxy", "https_proxy", "all_proxy"}}
        chat = subprocess.Popen([BINDING.processes[0][0].cmdline()[0],
            "--input-type=module", "-e", source, str(root / "bootstrap.json"),
            str(workspace / "01-product-half-finished/backend/phase0/gateway/package.json")],
            stdin=subprocess.PIPE, stdout=open(root / "rtc.log", "a"), stderr=subprocess.STDOUT, env=child_env)
    try:
        for text in args if chat else (None,):
            if chat:
                before = {p.name for p in (home / "storage/run-bindings").glob("*")}
                mark = len(log.read_text().splitlines()) if log.exists() else 0
                chat.stdin.write((json.dumps(text, ensure_ascii=False) + "\n").encode()); chat.stdin.flush()
            deadline = time.monotonic() + 600
            admission = None
            while time.monotonic() < deadline:
                for path in (home / "storage/run-bindings").glob("*"):
                    if path.name not in before:
                        admission = {**json.loads((home / "storage/admissions" / path.name).read_text()),
                                     **json.loads(path.read_text())}
                if admission:
                    status = call("/v1/runs/" + admission["run_id"])
                    if status["status"] not in ("queued", "running", "in_progress", "pending"):
                        break
                if chat and chat.poll() is not None:
                    raise RuntimeError("Formal RTC publisher exited; see rtc.log")
                time.sleep(3)
            else:
                raise TimeoutError("Staging admission/run did not complete")
            calls = [json.loads(line) for line in log.read_text().splitlines()[mark:]] if log.exists() else []
            if step == "unconfirmed":
                assert not any(c["tool"] in ("control_device", "run_scene") for c in calls), calls
            assert not any(c["tool"] in ("control_device", "run_scene") and "入户门锁" in json.dumps(c["args"], ensure_ascii=False) for c in calls), calls
            report = {"step": step, "args": (text,) if chat else args, "admission": admission, "run": status, "mijia": calls,
                      "synthetic_fixture": True, "real_world_claim": False}
            (root / ("run-" + admission["run_id"] + ".json")).write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
            print(json.dumps({"run_id": admission["run_id"], "status": status["status"], "output": status.get("output"), "mijia": calls}, ensure_ascii=False), flush=True)
            assert status["status"] == "completed", status
    finally:
        if chat:
            chat.stdin.close()
            try:
                chat.wait(timeout=15)
            except subprocess.TimeoutExpired:
                chat.terminate(); chat.wait(timeout=15)


async def cron_native():
    """Real native store + script execution + locked ticker; fake loopback delivery only."""
    urllib.request.install_opener(_isolated_opener())
    import asyncio
    import os
    import secrets
    import threading
    from pathlib import Path
    from aiohttp import web
    from personal_aios import PersonalAIOSProvider
    from personal_aios.cron import register, reminders
    from cron.jobs import get_job
    from cron.scheduler_provider import InProcessCronScheduler
    from gateway.config import Platform, PlatformConfig
    from gateway.platform_registry import PlatformEntry, platform_registry
    from gateway.run_scope import restrict_agent, tool_block
    from types import SimpleNamespace
    home = Path(os.environ["HERMES_HOME"]).resolve()
    workspace = Path(__file__).resolve().parents[4]
    assert home.is_relative_to(workspace / ".reminders-staging"), "Only a worktree staging home is permitted"
    home.mkdir(parents=True, exist_ok=True)
    key = secrets.token_hex(32)
    (home / "internal.key").write_text(key)
    deliveries = []
    script_failed = asyncio.Event()
    failure_job_id = ""
    owner = {"principal_id": "cron-fixture-owner", "device_id": "cron-fixture-phone"}
    async def internal(request):
        assert request.headers.get("Authorization") == "Bearer " + key
        body = await request.json()
        if request.path.endswith("schedule-context"):
            return web.json_response(owner)
        if request.path.endswith("scheduled-delivery"):
            deliveries.append({**body, "received_at": now()})
            if body["id"] == failure_job_id:
                script_failed.set()
        return web.json_response({"status": "delivered"})
    app = web.Application()
    app.router.add_post("/internal/hermes/{operation}", internal)
    server = web.AppRunner(app)
    await server.setup()
    site = web.TCPSite(server, "127.0.0.1", 0)
    await site.start()
    port = site._server.sockets[0].getsockname()[1]
    import yaml
    (home / "config.yaml").write_text(yaml.safe_dump({"cron": {"wrap_response": False}, "platforms": {"personal_aios": {"enabled": True}},
        "personal_aios": {"internal_base_url": f"http://127.0.0.1:{port}", "internal_key_file": str(home / "internal.key")}}))
    class Context:
        def register_tool(self, name, toolset, schema, handler, **kwargs):
            self.handler = handler
            return True
        def register_platform(self, name, label, factory, check, **kwargs):
            platform_registry.register(PlatformEntry(name=name, label=label, adapter_factory=factory, check_fn=check, **kwargs))
            self.factory = factory
        def register_platform_handler(self, *args):
            pass
    context = Context()
    register(context, PersonalAIOSProvider())
    async def manage(args):
        result = json.loads(await asyncio.to_thread(context.handler, args))
        assert result.get("success"), result
        return result
    (home / "scripts/native-contract.py").write_text('print("native script output")\n')
    scripted = await manage({"action": "create", "schedule": "in 30m", "prompt": "native script task",
                             "no_agent": True, "script": "native-contract.py"})
    assert get_job(scripted["job_id"])["script"] == "native-contract.py" and get_job(scripted["job_id"])["no_agent"]
    await manage({"action": "update", "job_id": scripted["job_id"], "reminder_text": "固定原文"})
    assert any(row["id"] == scripted["job_id"] for row in reminders(owner["principal_id"]))
    await manage({"action": "update", "job_id": scripted["job_id"], "name": "native changed name",
                  "no_agent": False, "script": "native-contract.py"})
    changed = get_job(scripted["job_id"])
    assert changed["name"] == "native changed name" and changed["no_agent"] is False and changed["script"] == "native-contract.py"
    assert not any(row["id"] == scripted["job_id"] for row in reminders(owner["principal_id"]))
    await manage({"action": "remove", "job_id": scripted["job_id"]})
    once = await manage({"action": "create", "schedule": "in 2m", "reminder_text": "两分钟提醒原文：喝水 300 ml"})
    cancelled = await manage({"action": "create", "schedule": "in 2m", "reminder_text": "已取消，不应送达"})
    await manage({"action": "remove", "job_id": cancelled["job_id"]})
    recurring = await manage({"action": "create", "schedule": "1m", "repeat": 2, "reminder_text": "每分钟定时原文"})
    assert len(reminders(owner["principal_id"])) == 1
    failing = await manage({"action": "create", "schedule": (datetime.datetime.now(datetime.timezone.utc)
        + datetime.timedelta(seconds=3)).isoformat(), "reminder_text": "失败任务不能被冒充成功提醒"})
    failure_job_id = failing["job_id"]
    for scope in ("care", "guest"):
        agent = SimpleNamespace(tools=[{"type": "function", "function": {"name": "cronjob_manage"}}])
        restrict_agent(agent, scope)
        assert not agent.tools and tool_block(agent, "cronjob_manage")
    delivery = context.factory(PlatformConfig(enabled=True))
    marker = home / "scripts/personal-aios-reminder.py"
    marker.write_text('raise RuntimeError("fixture-script-failure")\n')
    stopped = threading.Event()
    ticker = asyncio.create_task(asyncio.to_thread(InProcessCronScheduler().start, stopped,
        interval=1, adapters={Platform("personal_aios"): delivery}, loop=asyncio.get_running_loop()))
    try:
        await asyncio.wait_for(script_failed.wait(), timeout=15)
        marker.write_text('print("personal-aios-reminder")\n')
        await asyncio.sleep(135)
    finally:
        stopped.set()
        await ticker
        await server.cleanup()
    ids = [d["id"].split(":", 1)[0] for d in deliveries]
    assert ids.count(once["job_id"]) == 1, deliveries
    assert cancelled["job_id"] not in ids, deliveries
    assert ids.count(recurring["job_id"]) == 2, deliveries
    assert ids.count(failing["job_id"]) == 1, deliveries
    failure = next(d for d in deliveries if d["id"] == failing["job_id"])
    assert "failed" in failure["text"] and "Script exited with code 1" in failure["text"]
    assert "fixture-script-failure" in get_job(failing["job_id"])["last_error"]
    assert failure["text"] != failing["name"] and "reminder_id" not in failure
    assert get_job(once["job_id"])["repeat"]["completed"] == 1
    assert all(d["text"] == ("两分钟提醒原文：喝水 300 ml" if d["id"] == once["job_id"] else "每分钟定时原文")
               for d in deliveries if d["id"] != failing["job_id"])
    report = {"status": "passed", "native_ticker": True, "duration_seconds": 135, "deliveries": deliveries,
              "cancelled_job_id": cancelled["job_id"], "care_guest_cron_blocked": True,
              "script_failure_delivered_without_reminder_id": True, "native_task_fields_preserved": True}
    (home / "cron-evidence.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print(json.dumps(report, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    urllib.request.install_opener(_isolated_opener())
    if sys.argv[1:] == ["--cron-native"]:
        import asyncio
        asyncio.run(cron_native())
    elif sys.argv[1:2] == ["--payment-recovery"]:
        payment_recovery(*sys.argv[2:])
    elif sys.argv[1:2] == ["--payment"]:
        payment(*sys.argv[2:])
    elif sys.argv[1:2] == ["--commute"]:
        commute(*sys.argv[2:])
    else:
        main(sys.argv[1:])

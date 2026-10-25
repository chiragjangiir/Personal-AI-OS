"""The production MCP contract with in-memory Xiaomi stand-ins; no network."""
import copy
import os
from pathlib import Path
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))
from mijia import create_server
sys.path.pop(0)


def urn(kind, name):
    return f"urn:miot-spec-v2:{kind}:{name}:00000001:staging:1"


class FakeAPI:
    def __init__(self):
        self._complete_qr_login(None)
        self.outcome = os.environ.get("PAIOS_FAKE_MIJIA_OUTCOME", "succeeded")
        self.writes = 0
        if self.outcome == "login_required":
            self.auth_data.clear()
        self.devices = [{"did": str(i), "name": name, "home_id": "1", "spec_type": urn("device", kind)}
                        for i, (name, kind) in enumerate([("客厅灯", "light"), ("入户门锁", "door-lock"),
                            ("空调", "air-conditioner"), ("净化器", "air-purifier"), ("窗帘", "curtain")])]
        self.values = {(d["did"], s["iid"], p["iid"]): 30 if p["type"].split(":")[3] == "indoor-temperature"
                       else 2 if p["type"].split(":")[3] == "motor-control" else False
                       for d in self.devices for s in load_spec(d["spec_type"])["services"] for p in s["properties"]}

    def get_homes_list(self):
        return [{"id": "1", "name": "家", "roomlist": [{"name": "客厅", "dids": [d["did"] for d in self.devices]}]}]

    def get_devices_list(self):
        return copy.deepcopy(self.devices)

    def _get_qr_login_data(self):
        return {"loginUrl": "https://example.invalid/staging-mijia-login"}

    def _complete_qr_login(self, data):
        self.auth_data = {"expireTime": (time.time() + 86400) * 1000, "serviceToken": "synthetic-session-secret"}
        return self.auth_data

    def get_devices_prop(self, params):
        return [{**p, "code": 0, "value": self.values.get((p["did"], p["siid"], p["piid"]), False)} for p in params]

    def set_devices_prop(self, params):
        self.writes += 1
        if self.outcome == "unknown":
            import requests
            raise requests.Timeout("synthetic transport timeout")
        if self.outcome == "accepted":
            return {"code": 1}
        if self.outcome == "failed" or self.outcome == "incomplete" and self.writes > 1:
            return {"code": -1}
        self.values[(params["did"], params["siid"], params["piid"])] = params["value"]
        return {"code": 0}

    def run_action(self, params):
        return {"code": 0}


def load_spec(device_type):
    kind = device_type.split(":")[3]
    properties = [{"type": urn("property", "on"), "iid": 1, "format": "bool", "access": ["read", "write"]}]
    if kind == "curtain":
        properties = [{"type": urn("property", "motor-control"), "iid": 1, "format": "uint8", "access": ["read", "write"],
            "value-list": [{"value": 0, "description": "Open"}, {"value": 1, "description": "Close"}, {"value": 2, "description": "Stop"}]}]
    if kind == "air-conditioner":
        properties.append({"type": urn("property", "indoor-temperature"), "iid": 2, "format": "float", "unit": "celsius", "access": ["read"]})
    return {"type": device_type, "services": [{"type": urn("service", kind), "iid": 2,
        "properties": properties,
        "actions": [{"type": urn("action", "unlock" if "lock" in kind else "toggle"), "iid": 1, "in": [], "out": []}]}]}


if __name__ == "__main__":
    os.umask(0o077)
    root = Path(os.environ["HERMES_HOME"]) / "mijia"
    root.mkdir(mode=0o700, exist_ok=True)
    create_server(FakeAPI(), load_spec, root, os.environ["PAIOS_FAKE_MIJIA_LOG"]).run("stdio")

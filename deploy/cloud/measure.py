#!/usr/bin/env python3
"""Explicit host-side IPv4 outbound probes or container RAM sampling; no global routing changes."""
import argparse
import json
import math
import os
from pathlib import Path
import re
from string import Template
import subprocess
import tempfile
import time
from urllib.parse import parse_qsl, urlencode, urlsplit


def percentile(values, percent):
    return sorted(values)[max(0, math.ceil(len(values) * percent / 100) - 1)] if values else None


def summary(values):
    return {"p50": percentile(values, 50), "p95": percentile(values, 95)}


def outbound(args):
    config = json.loads(Path(args.config).read_text())
    if args.proxy:
        proxy = urlsplit(args.proxy)
        if proxy.scheme not in ("http", "https") or not proxy.hostname or proxy.username or proxy.password:
            raise ValueError("proxy must be a credential-free HTTP(S) URL")
    def key_path(value):
        return Path(value.replace("${PAIOS_SECRET_ROOT}", args.secrets_dir))
    voice = config["voice_frontend"]
    targets = [("deepseek_chat", "https://api.deepseek.com/chat/completions",
                Path(args.deepseek_key_file), args.deepseek_model)]
    targets.append(("dashscope_ws_upgrade", Template(voice["endpoint"]).substitute(os.environ), key_path(voice["key_file"]), None))
    report = []
    for label, endpoint, key_file, model in targets:
        parsed = urlsplit(endpoint)
        if parsed.scheme not in ("https", "wss") or parsed.username or parsed.password:
            raise ValueError("only credential-free TLS endpoints are accepted")
        key = key_file.read_text().strip()
        if any(char in key for char in '\r\n"\\'):
            raise ValueError("invalid API key file format")
        samples = []
        for _ in range(args.samples):
            with tempfile.TemporaryDirectory() as tmp:
                bodyfile = Path(tmp) / "response"
                headers = f'header = "Authorization: Bearer {key}"\n'
                command = ["curl", "-4", "--silent", "--config", "-", "--connect-timeout", "15",
                           "--max-time", str(args.timeout), "--output", str(bodyfile),
                           "--user-agent", "paios-cloud-outbound/1.0", "--write-out", "%{json}"]
                if args.proxy:
                    command += ["--proxy", args.proxy]
                else:
                    command += ["--noproxy", "*"]
                if parsed.scheme == "wss":
                    query = dict(parse_qsl(parsed.query))
                    query["model"] = voice["model"]
                    url = parsed._replace(scheme="https", query=urlencode(query)).geturl()
                    command += ["--head", "--request", "GET", "--http1.1", "-H", "Connection: Upgrade", "-H", "Upgrade: websocket",
                                "-H", "Sec-WebSocket-Version: 13", "-H", "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==", url]
                else:
                    payload = {"model": model, "messages": [{"role": "user", "content": "Reply with OK only."}],
                               "max_tokens": 128, "stream": False, "thinking": {"type": "disabled"}}
                    request = Path(tmp) / "request"
                    request.write_text(json.dumps(payload))
                    command += ["-H", "Content-Type: application/json",
                                "--data-binary", f"@{request}", endpoint]
                result = subprocess.run(command, input=headers, text=True, capture_output=True)
                timing = json.loads(result.stdout) if result.stdout.strip() else {}
                status = int(timing.get("http_code", 0))
                valid = result.returncode == 0 and status == (101 if parsed.scheme == "wss" else 200)
                if parsed.scheme == "wss" and status == 101:
                    response_headers = {name.lower(): value.strip() for line in bodyfile.read_text().splitlines()
                                        if ":" in line for name, value in [line.split(":", 1)]}
                    # HTTP-only curl reports empty reply after the completed 101.
                    valid = (status == 101 and result.returncode in (0, 52)
                             and response_headers.get("upgrade", "").lower() == "websocket"
                             and "upgrade" in response_headers.get("connection", "").lower().replace(" ", "").split(",")
                             and response_headers.get("sec-websocket-accept") == "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=")
                if valid and parsed.scheme != "wss":
                    try:
                        response = json.loads(bodyfile.read_text())
                    except json.JSONDecodeError:
                        valid = False
                    else:
                        valid = bool(response.get("choices", []) and response["choices"][0].get("message", {}).get("content"))
                dns = timing.get("time_namelookup", 0)
                connected = timing.get("time_connect", 0)
                tls = timing.get("time_appconnect", 0)
                samples.append({"ok": valid, "http": status, "curl_exit": result.returncode,
                                "dns_ms": dns * 1000, "connect_ms": max(0, connected - dns) * 1000,
                                "tls_ms": max(0, tls - connected) * 1000,
                                "ttfb_ms": timing.get("time_starttransfer", 0) * 1000,
                                "total_ms": timing.get("time_total", 0) * 1000})
            time.sleep(args.interval)
        good = [sample for sample in samples if sample["ok"]]
        report.append({"probe": label, "host": parsed.hostname, "transport": "ipv4",
                       "route": args.proxy or "direct", "samples": samples,
                       "successes": len(good), "failures": len(samples) - len(good),
                       "metrics": {metric: summary([sample[metric] for sample in good])
                                   for metric in ["dns_ms", "connect_ms", "tls_ms", "ttfb_ms", "total_ms"]}})
    print(json.dumps(report, indent=2))
    if any(probe["failures"] for probe in report):
        raise SystemExit(1)


def bytes_used(value):
    number, unit = re.fullmatch(r"([0-9.]+)\s*([A-Za-z]+)", value.split(" / ")[0]).groups()
    factors = {"B": 1, "KiB": 1024, "MiB": 1024 ** 2, "GiB": 1024 ** 3,
               "kB": 1000, "MB": 1000 ** 2, "GB": 1000 ** 3}
    return float(number) * factors[unit]


def memory(args):
    compose = ["docker", "compose", "--env-file", args.env_file]
    public_env = Path(args.compose).resolve().parent / ".build/production.public.env"
    if public_env.is_file():
        compose += ["--env-file", str(public_env)]
    compose += ["-f", args.compose, "--profile", args.profile]
    records = {}
    host_samples = []
    start = time.monotonic()
    while time.monotonic() - start < args.duration:
        ids = subprocess.run(compose + ["ps", "--status", "running", "-q"], check=True,
                             capture_output=True, text=True).stdout.split()
        if not ids:
            raise ValueError("no running compose containers")
        result = subprocess.run(["docker", "stats", "--no-stream", "--format", "{{json .}}", *ids],
                                check=True, capture_output=True, text=True)
        for line in result.stdout.splitlines():
            row = json.loads(line)
            records.setdefault(row["Name"], []).append((time.monotonic() - start, bytes_used(row["MemUsage"])))
        host = {}
        for line in Path("/proc/meminfo").read_text().splitlines():
            name, value = line.split(":", 1)
            if name in ("MemTotal", "MemAvailable", "SwapTotal", "SwapFree"):
                host[name] = int(value.split()[0]) * 1024
        host_samples.append(host)
        time.sleep(args.interval)
    report = {}
    for name, values in records.items():
        steady = [value for elapsed, value in values if elapsed >= args.warmup]
        report[name] = {"samples": len(values), "steady_samples": len(steady),
                        "steady_bytes": summary(steady), "peak_bytes": max(value for _, value in values)}
    print(json.dumps({"duration_seconds": args.duration, "warmup_seconds": args.warmup,
                      "memory_source": "docker stats MemUsage (Linux cache-adjusted)",
                      "host_bytes": {name: min(row[name] for row in host_samples) for name in host_samples[0]},
                      "containers": report}, indent=2))


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    probe = sub.add_parser("outbound")
    probe.add_argument("--config", required=True)
    probe.add_argument("--deepseek-key-file", required=True)
    probe.add_argument("--deepseek-model", required=True)
    probe.add_argument("--secrets-dir", required=True, help="host equivalent of container /run/secrets")
    probe.add_argument("--samples", type=int, default=20)
    probe.add_argument("--timeout", type=int, default=90)
    probe.add_argument("--interval", type=float, default=2)
    probe.add_argument("--proxy", help="explicit per-host HTTP forward proxy; never changes global routes")
    ram = sub.add_parser("memory")
    ram.add_argument("--compose", required=True)
    ram.add_argument("--env-file", required=True)
    ram.add_argument("--profile", choices=["production", "staging"], default="production")
    ram.add_argument("--duration", type=float, default=300)
    ram.add_argument("--warmup", type=float, default=60)
    ram.add_argument("--interval", type=float, default=5)
    args = parser.parse_args()
    if args.interval <= 0:
        parser.error("interval must be positive")
    if args.command == "outbound" and (args.samples <= 0 or args.timeout <= 0):
        parser.error("samples and timeout must be positive")
    if args.command == "memory" and not 0 <= args.warmup < args.duration:
        parser.error("memory duration must exceed nonnegative warmup")
    outbound(args) if args.command == "outbound" else memory(args)


if __name__ == "__main__":
    main()

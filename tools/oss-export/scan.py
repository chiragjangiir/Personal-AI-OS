#!/usr/bin/env python3
"""Scan only materialized public files. Never emit matched text or secret labels."""
import ipaddress
import json
import os
import re
import shutil
import subprocess
import tempfile
from collections import Counter
from pathlib import Path


def scan(root, policy, *, private=None):
    """Scan one tree with public patterns and optional caller-supplied private values."""
    specs = dict(policy['rules'])
    if private is not None:
        specs.update(private['private_policy']['rules'])
    patterns = {name: (re.compile(item['pattern'], item['flags']), item['kind'])
                for name, item in specs.items()}
    public_domains = policy['public_domains']
    needles = private['known_secrets'] if private is not None else set()
    privacy_values = private['privacy_values'] if private is not None else []
    namespaces = {n['host'] for n in policy.get('public_namespaces', [])}
    public_contacts = {(n['file'], n['line'], n['email']) for n in policy.get('public_notice_contacts', [])}
    hits, lines = set(), {}

    def add(kind, rule, path, line):
        hits.add((kind, rule, path, line))

    paths = sorted(p for p in root.rglob('*') if p.is_file() and '.git' not in p.relative_to(root).parts)
    for path in paths:
        rel = path.relative_to(root).as_posix()
        data = path.read_bytes()
        for value in needles:
            for encoding in ('utf-8', 'utf-16-le', 'utf-16-be'):
                target, start = value.encode(encoding), 0
                while (offset := data.find(target, start)) >= 0:
                    add('secret', 'known-secret', rel, data[:offset].count(b'\n') + 1)
                    start = offset + len(target)
        # Binary content still receives exact-byte secret checks and gitleaks archive checks.
        if b'\0' in data[:4096]:
            continue
        lines[rel] = data.decode('utf-8', 'replace').splitlines()
        for number, line in enumerate(lines[rel], 1):
            if any(value in line for value in privacy_values):
                add('privacy', 'private-needle', rel, number)
            for rule, (pattern, kind) in patterns.items():
                for match in pattern.finditer(line):
                    value = match.group()
                    if rule == 'ipv4':
                        try:
                            addr = ipaddress.IPv4Address(value)
                        except ipaddress.AddressValueError:
                            continue
                        if addr.is_loopback or addr.is_unspecified or any(addr in ipaddress.ip_network(n) for n in ('192.0.2.0/24', '198.51.100.0/24', '203.0.113.0/24')):
                            continue
                    if rule == 'domain' and not (line[max(0, match.start()-3):match.start()].endswith('://') or re.search(r'[\"\'=]\s*$', line[:match.start()]) or re.search(r'(?i)host|server_name|serverAddr', line[:match.start()])):
                        continue
                    if rule == 'domain' and (value in namespaces or any(value.lower() == d or value.lower().endswith('.' + d) for d in public_domains)):
                        continue
                    if rule == 'email' and (rel, number, value) in public_contacts:
                        continue
                    if rule == 'email' and value.rsplit('@', 1)[-1].lower() in {'example.com', 'example.org', 'example.net', 'example.invalid'}:
                        continue
                    add(kind, rule, rel, number)
        if path.suffix.lower() in {'.wav', '.m4a', '.mp3', '.mp4', '.jpg', '.jpeg', '.heic'}:
            add('privacy', 'media-review', rel, 1)
    if not shutil.which('gitleaks'):
        raise ValueError('gitleaks is required')
    with tempfile.TemporaryDirectory(prefix='oss-gitleaks-') as tmp:
        command = ['gitleaks', 'dir', '--no-banner', '--no-color', '--redact=100',
                   '--ignore-gitleaks-allow', '--gitleaks-ignore-path', tmp,
                   '--max-archive-depth', '2', '--report-format', 'json', '--report-path', '-', str(root)]
        environment = {k: v for k, v in os.environ.items() if k not in {'GITLEAKS_CONFIG', 'GITLEAKS_CONFIG_TOML'}}
        result = subprocess.run(command, capture_output=True, env=environment)
        if result.returncode not in (0, 1):
            raise ValueError('gitleaks execution failed; diagnostics withheld')
        for item in json.loads(result.stdout or b'[]'):
            p = Path(item['File'])
            rel = p.relative_to(root).as_posix() if p.is_absolute() else p.as_posix()
            add('secret', 'gitleaks:' + item['RuleID'], rel, item['StartLine'])
    approvals = {}
    policy_path = policy.get('public_scan_policy')
    if policy_path:
        for rule, specification in policy['rules'].items():
            line = '"pattern": ' + json.dumps(specification['pattern'], ensure_ascii=False) + ','
            approvals.setdefault((rule, policy_path), []).append((
                re.compile(re.escape(line)), 'Exact published rule syntax, bound to the current policy specification'))
    reviews = [(item, True) for item in policy.get('scan_allowlist', [])]
    if private is not None:
        reviews.extend((item, False) for item in private['private_policy'].get('scan_allowlist', []))
    for item, serialized in reviews:
        scoped = [(scope['file'], pattern) for scope in item['scope'] for pattern in scope['line_patterns']] \
            if 'scope' in item else [(item['file'], item['line_pattern'])]
        for filename, pattern in scoped:
            if any(c in filename for c in '*?[') or not item['reason'].strip():
                raise ValueError('Scan approval requires an exact file and a review reason')
            approvals.setdefault((item['rule'], filename), []).append((re.compile(pattern), item['reason']))
            if policy_path and serialized:
                # Serialized reviews repeat the same approved line, not a new value.
                value = json.dumps(pattern, ensure_ascii=False)
                serialized_lines = [value, value + ','] if 'scope' in item else ['"line_pattern": ' + value + ',']
                for line in serialized_lines:
                    approvals.setdefault((item['rule'], policy_path), []).append((re.compile(re.escape(line)), item['reason']))
    if policy_path:
        for item in policy.get('public_notice_contacts', []):
            line = '"email": ' + json.dumps(item['email']) + ','
            approvals.setdefault(('email', policy_path), []).append((re.compile(re.escape(line)), item['reason']))
    records, reviewed = [], []
    for k, r, f, n in sorted(hits):
        record = {'kind': k, 'rule': r, 'file': f, 'line': n}
        line = lines.get(f, [])
        reason = next((reason for pattern, reason in approvals.get((r, f), [])
                       if r != 'known-secret' and 0 < n <= len(line) and pattern.fullmatch(line[n - 1].strip())), None)
        if reason:
            reviewed.append({**record, 'reason': reason})
        else:
            records.append({**record, 'fix': 'move-to-config' if r in {'ipv4', 'domain', 'home-path', 'app-key'}
                            else 'replace-with-fictional-data-or-exclude'})
    return {'mode': 'private' if private is not None else 'public', 'known_secret_scan': private is not None,
            'files_scanned': len(paths), 'secret_files_read': private['secret_files_read'] if private is not None else 0,
            'secret_needles': len(needles), 'secret_source_roots': private['secret_source_roots'] if private is not None else 0,
            'privacy_needles': len(set(privacy_values)), 'local_privacy_files': private['local_privacy_files'] if private is not None else 0,
            'raw_counts': dict(Counter(k for k, _, _, _ in hits)), 'reviewed': reviewed,
            'counts': dict(Counter(x['kind'] for x in records)), 'rules': dict(Counter(x['rule'] for x in records)),
            'approved_protocol_namespaces': len(namespaces), 'approved_legal_contacts': len(public_contacts), 'hits': records, 'passed': not records}

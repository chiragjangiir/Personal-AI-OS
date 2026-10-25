"""Execution idempotency and status, not consent or the platform's reporting ledger."""
import hashlib
import json
import sqlite3
from contextlib import closing, contextmanager
from pathlib import Path

from capability.sdk.python.yimi_receipt import receipt
from .receipt import mapped, uncertain


class Delivery:
    def __init__(self, path, sender):
        self.path, self.sender = Path(path), sender
        self.path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        with self.db() as db:
            db.execute('CREATE TABLE IF NOT EXISTS calls (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result TEXT)')

    @contextmanager
    def db(self):
        with closing(sqlite3.connect(self.path, timeout=10)) as db:
            with db:
                yield db

    def invoke(self, idempotency_key='', **args):
        if args.get('action') == 'list':
            try:
                return mapped(self.sender(args), args)
            except Exception:
                return uncertain('directory', 'TRANSPORT_DISCONNECTED')
        if not idempotency_key:
            return receipt('failed', status={'reason_code': 'GATEWAY_CALL_BINDING_REQUIRED'})
        fingerprint = hashlib.sha256(json.dumps(args, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
        with self.db() as db:
            inserted = db.execute('INSERT OR IGNORE INTO calls (id, fingerprint) VALUES (?, ?)',
                                  (idempotency_key, fingerprint)).rowcount
            old_fingerprint, saved = db.execute('SELECT fingerprint, result FROM calls WHERE id=?', (idempotency_key,)).fetchone()
        if old_fingerprint != fingerprint:
            return receipt('failed', status={'reason_code': 'IDEMPOTENCY_CONFLICT'})
        if not inserted:
            return json.loads(saved) if saved else uncertain(args['target'], 'EXECUTION_RECOVERY_CHECK_REQUIRED')
        try:
            result = mapped(self.sender(args), args)
        except Exception:
            result = uncertain(args['target'], 'TRANSPORT_DISCONNECTED')
        with self.db() as db:
            db.execute('UPDATE calls SET result=? WHERE id=?', (json.dumps(result), idempotency_key))
        return result

    def status(self, idempotency_key):
        with self.db() as db:
            row = db.execute('SELECT result FROM calls WHERE id=?', (idempotency_key,)).fetchone()
        return json.loads(row[0]) if row and row[0] else uncertain('delivery', 'DELIVERY_CHECK_REQUIRED')

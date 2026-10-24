"""Test-only path binding; dispatch, unshare, mounts and task launch remain production code."""
import importlib.util
import os
from pathlib import Path
import sys

source = Path(os.environ['DK_KERNEL_SOURCE'])
sys.path.insert(0, str(source.parent))
spec = importlib.util.spec_from_file_location('kernel_broker', source)
broker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(broker)
base = Path(os.environ['DK_KERNEL_BASE'])
broker.ROOT = base / 'scopes'
broker.OWNER = base / 'owner'
broker.WORKSHOP = base / 'live'
broker.SNAPSHOTS = base / 'snapshots'
broker.__file__ = str(Path(__file__).resolve())
raise SystemExit(broker.dispatch())

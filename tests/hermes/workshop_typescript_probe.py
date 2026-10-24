"""Real npx/compiler regression inside the read-only workshop image, without a model or network."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--expected-version', required=True)
parser.add_argument('--tools', type=Path, default=Path('/opt/paios-repair-tools/node_modules'))
parser.add_argument('--scratch', type=Path, default=Path('/workshop'))
args = parser.parse_args()
with tempfile.TemporaryDirectory(prefix='typescript-probe-', dir=args.scratch) as directory:
    root = Path(directory)
    (root / 'node_modules').symlink_to(args.tools.resolve(), target_is_directory=True)
    home = root / 'home'
    home.mkdir()
    env = {**os.environ, 'HOME': str(home), 'NPM_CONFIG_PREFIX': str(home / '.local'),
           'NPM_CONFIG_CACHE': str(home / '.npm'), 'NPM_CONFIG_OFFLINE': 'true'}
    good, bad = root / 'good.ts', root / 'bad.ts'
    good.write_text('const answer: number = 42;\n')
    bad.write_text('const answer: number = ;\n')
    nested = root / 'nested'
    nested.mkdir()
    (nested / 'package.json').write_text('{"name":"synthetic-lint-project","private":true}\n')
    results = []
    for cwd in (root, nested):
        version = subprocess.run(['npx', 'tsc', '--version'], cwd=cwd, env=env,
                                 text=True, capture_output=True, timeout=30)
        assert version.returncode == 0 and version.stdout.strip() == 'Version ' + args.expected_version, version.stderr
        valid = subprocess.run(['npx', 'tsc', '--noEmit', str(good)], cwd=cwd, env=env,
                               text=True, capture_output=True, timeout=30)
        assert valid.returncode == 0, valid.stdout + valid.stderr
        invalid = subprocess.run(['npx', 'tsc', '--noEmit', str(bad)], cwd=cwd, env=env,
                                 text=True, capture_output=True, timeout=30)
        assert invalid.returncode != 0 and 'TS1109' in invalid.stdout, invalid.stdout + invalid.stderr
        results.append({'cwd': cwd.name, 'valid_passed': True, 'syntax_error_rejected': True})
    print(json.dumps({'typescript': args.expected_version, 'cases': results, 'uid': os.geteuid(),
                      'model_api_calls': 0, 'npm_offline': True, 'passed': True}))

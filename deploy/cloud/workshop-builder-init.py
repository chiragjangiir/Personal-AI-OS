"""Create a data-free native Hermes profile for the workshop service."""
import os
from pathlib import Path
import subprocess

import yaml


def prepare_builder_home(home, access=Path('/run/workshop-access')):
    home, access = Path(home), Path(access)
    provider = os.environ.get('PAIOS_BUILDER_PROVIDER', 'paios-builder')
    if provider.strip().lower() == 'opencode-go':
        raise ValueError('Use a custom provider name; opencode-go selects native provider behavior')
    model = os.environ.get('PAIOS_BUILDER_MODEL', 'deepseek-v4.1-flash')
    base_url = os.environ.get('PAIOS_BUILDER_BASE_URL', 'https://opencode.ai/zen/go/v1')
    config_file = home / 'config.yaml'
    existing = yaml.safe_load(config_file.read_text()) if config_file.exists() else {}
    repair_model = os.environ.get('PAIOS_BUILDER_REPAIR_MODEL') or (existing or {}).get('workshop', {}).get('repair_model')
    if repair_model is not None and (not isinstance(repair_model, str) or not repair_model.strip()):
        raise ValueError('workshop.repair_model must be a nonempty model name')
    key = home / 'workshop-ssh/id_ed25519'
    key.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    access.mkdir(mode=0o755, parents=True, exist_ok=True)
    if not key.exists():
        subprocess.run(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', str(key)], check=True)
    authorized = access / 'authorized_keys'
    authorized.write_bytes(b'restrict,command="/usr/local/bin/workshop-scope" ' +
                           key.with_suffix('.pub').read_bytes())
    authorized.chmod(0o644)
    toolsets = ['skills', 'terminal', 'file', 'code_execution', 'skills_hub', 'todo']
    config = {
        'model': {'default': model, 'provider': provider, 'base_url': base_url},
        'workshop': {'repair_model': repair_model} if repair_model is not None else {},
        'custom_providers': [{'name': provider, 'base_url': base_url,
            'key_env': 'PAIOS_BUILDER_API_KEY', 'api_mode': 'chat_completions',
            'context_length': 262144}],
        # One shared tool-call cap bounds a build, as in the product profile; no turn or time limit.
        'agent': {'max_tool_calls': int(os.environ.get('PAIOS_BUILDER_MAX_TOOL_CALLS', '120')),
            'tool_call_milestone_interval': int(os.environ.get('PAIOS_BUILDER_TOOL_CALL_MILESTONE_INTERVAL', '20')),
            'api_max_retries': 1, 'auto_recovery_cycles': 0, 'max_tokens': 8192},
        'terminal': {'backend': 'ssh', 'ssh_host': os.environ.get('PAIOS_WORKSHOP_HOST', 'workshop'),
            'ssh_user': 'root', 'ssh_port': 2222, 'ssh_key': str(key),
            'cwd': '/workshop', 'ssh_isolated': True},
        'skills': {'external_dirs': [], 'inline_shell': False, 'create_dir': '',
            'guard_agent_created': True},
        'platform_toolsets': {'api_server_build': toolsets},
        'memory': {'memory_enabled': False, 'user_profile_enabled': False},
        'tools': {'tool_search': {'enabled': 'off'}},
        'approvals': {'mode': 'manual', 'cron_mode': 'deny',
            'single_query_mode': 'deny', 'unattended_mode': 'deny'},
        'auxiliary': {'title_generation': {'enabled': False, 'model_upgrade_enabled': False}},
        'network': {'force_ipv4': True}, 'security': {'allow_private_urls': False},
        'plugins': {'enabled': []}, 'mcp_servers': {},
        'fallback_providers': [], 'sync': {'enabled': False},
    }
    paths = [home, key.parent, key, key.with_suffix('.pub')]
    for profile in (home, home / 'workshop'):
        profile.mkdir(mode=0o700, parents=True, exist_ok=True)
        profile.chmod(0o700)
        config_file = profile / 'config.yaml'
        config_file.write_text(yaml.safe_dump(config, allow_unicode=True, sort_keys=False))
        config_file.chmod(0o600)
        paths.extend([profile, config_file])
    if os.geteuid() == 0:
        # Root holds no CAP_DAC_OVERRIDE here: hand a 0700 directory to the builder only after its contents.
        for path in sorted(set(paths), key=lambda item: len(item.parts), reverse=True):
            os.chown(path, 10000, 10000)
    return config

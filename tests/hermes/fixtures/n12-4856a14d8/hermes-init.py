"""Compose the cloud product with owner transport, runtime state and deployment paths."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time

import yaml
from dotenv import dotenv_values, unset_key

SECRETS = Path('/run/secrets')
ACCESS = Path('/run/workshop-access')
MODELS = Path('/etc/paios/models.json')


# Owner model transport is independent of the shipped product behavior.
OWNER_KEYS = (
    'model', 'providers', 'custom_providers', 'fallback_providers', 'fallback_model',
    'fallback', 'credential_pool_strategies', 'model_catalog', 'model_overrides',
    'models_dev', 'openrouter', 'bedrock', 'vertex', 'nous', 'local_runtime',
    'smart_model_routing', 'image_gen', 'video_gen', 'x_search', 'tts', 'stt', 'timezone',
)
RUNTIME_KEYS = ('_config_version', 'command_allowlist', 'known_plugin_toolsets',
                'known_builtin_toolsets', 'tool_gateway_declined_tools')
AUXILIARY_ROUTES = (
    'vision', 'compression', 'skills_hub', 'approval', 'review', 'mcp', 'title_generation',
    'memory_query_rewrite', 'tts_audio_tags', 'triage_specifier', 'kanban_decomposer',
    'profile_describer', 'goal_judge', 'curator', 'monitor', 'background_review',
    'moa_reference', 'moa_aggregator',
)


def compose_config(product, existing):
    """Use the same ownership boundary for staging and production."""
    config = copy.deepcopy(product)
    if 'providers' in existing:
        # Hermes migrates custom_providers to providers; never reseed the legacy list.
        config.pop('custom_providers', None)
    for field in OWNER_KEYS + RUNTIME_KEYS:
        if field in existing:
            config[field] = copy.deepcopy(existing[field])
    auxiliary = existing.get('auxiliary', {})
    for field in ('free_only', 'openrouter_model', 'stream_only_base_urls'):
        if field in auxiliary:
            config.setdefault('auxiliary', {})[field] = copy.deepcopy(auxiliary[field])
    for task in AUXILIARY_ROUTES:
        if task in auxiliary:
            route = config.setdefault('auxiliary', {}).setdefault(task, {})
            route.update({key: copy.deepcopy(value) for key, value in auxiliary[task].items()
                          if key not in {'enabled', 'model_upgrade_enabled', 'max_input_tokens'}})
    fields = {
        'agent': ('max_tokens', 'reasoning_effort', 'reasoning_overrides', 'reasoning_echo',
                  'service_tier', 'fast_auto_seconds', 'text_verbosity', 'image_input_mode'),
        'delegation': ('model', 'provider', 'fallback_providers', 'base_url', 'api_key',
                       'api_mode', 'request_overrides', 'reasoning_effort', 'command', 'args'),
        'cron': ('model', 'model_provider'),
        'moa': ('presets',),
        'voice': ('gpt_live',),
        # Modes are product policy; deny rules are owner policy; confirmations are runtime choices.
        'approvals': ('timeout', 'smart_policy', 'denial_breaker_threshold', 'deny',
                      'mcp_reload_confirm', 'destructive_slash_confirm'),
        'monitoring': ('install_id',),
        'security': ('acked_advisories',),
        'onboarding': ('seen',),
    }
    for section, names in fields.items():
        for field in names:
            if field in existing.get(section, {}):
                config.setdefault(section, {})[field] = copy.deepcopy(existing[section][field])
    return config


def seed_config(home, product_config):
    config_file = home / 'config.yaml'
    if config_file.exists() and config_file.stat().st_size:
        return
    home.mkdir(parents=True, exist_ok=True)
    config_file.write_bytes(product_config.read_bytes())
    config_file.chmod(0o600)


def bind_image_path(path, target):
    if path.is_symlink():
        if path.resolve() == target.resolve():
            return
        path.unlink()
    elif path.exists():
        backups = path.parent / 'backups'
        backups.mkdir(exist_ok=True)
        os.chown(backups, 10000, 10000)
        path.rename(backups / f'{path.name}.cloud-import-{time.time_ns()}')
    path.symlink_to(target, target_is_directory=target.is_dir())


def agentbay_phone(home, integration, provider):
    if not ((SECRETS / 'agentbay.key').is_file() and (SECRETS / 'agentbay.key').read_text().strip()
            and os.environ.get('PAIOS_AGENTBAY_IMAGE')):
        return None
    executor = integration.parents[1] / 'connectors/phone_executor'
    return {'command': '/opt/paios-phone/bin/python',
        'args': [str(executor / 'server.py')], 'cwd': str(executor), 'env': {
            'PAIOS_PHONE_PROVIDER': provider, 'PAIOS_AGENTBAY_IMAGE': os.environ['PAIOS_AGENTBAY_IMAGE'],
            'PAIOS_AGENTBAY_KEY_FILE': str(SECRETS / 'agentbay.key'),
            'PAIOS_AGENTBAY_ADBKEY': str(SECRETS / 'agentbay.adbkey'),
            'PAIOS_DEEPSEEK_KEY_FILE': str(SECRETS / 'deepseek.key'),
            'PAIOS_SILICONFLOW_KEY_FILE': str(SECRETS / 'siliconflow.key'),
            'PAIOS_MOBILERUN_CONFIG': str(executor / 'mobilerun-config.example.yaml'),
            'PAIOS_AGENTBAY_STATE': str(home / 'agentbay-session.json'),
            'PAIOS_AGENTBAY_CONTEXT_PREFIX': os.environ.get('PAIOS_AGENTBAY_CONTEXT_PREFIX', 'paios-app-'),
            'PAIOS_ERRAND_SPOOL': '/var/lib/paios/state/errands'}, 'timeout': 660}


def mac_android_phone(home, integration, provider):
    executor = integration.parents[1] / 'connectors/phone_executor'
    return {'command': '/opt/paios-phone/bin/python',
        'args': [str(executor / 'server.py')], 'cwd': str(executor), 'env': {
            'PAIOS_PHONE_PROVIDER': provider,
            'PAIOS_INTEGRATION_PORT': os.environ['PAIOS_INTEGRATION_PORT'],
            'PAIOS_DEEPSEEK_KEY_FILE': str(SECRETS / 'deepseek.key'),
            'PAIOS_SILICONFLOW_KEY_FILE': str(SECRETS / 'siliconflow.key'),
            'PAIOS_MOBILERUN_CONFIG': str(executor / 'mobilerun-config.example.yaml'),
            'PAIOS_ERRAND_SPOOL': '/var/lib/paios/state/errands'}, 'timeout': 660}


PHONE_PROVIDERS = {'agentbay': agentbay_phone, 'mac-android': mac_android_phone,
                   'off': lambda home, integration, provider: None}


def single_host_models(config):
    """Apply explicitly configured public model roles; private transport is untouched."""
    if os.environ.get('PAIOS_DEPLOYMENT') != 'single-host':
        return {}
    roles = json.loads(MODELS.read_text())
    config.pop('providers', None)
    config['custom_providers'] = [
        {'name': role['provider'], 'base_url': role['base_url'],
         'key_env': f'PAIOS_{name.upper()}_API_KEY', 'api_mode': 'chat_completions'}
        for name, role in roles.items() if name not in ('realtime', 'tts')]
    brain = roles['brain']
    config['model'] = {'default': brain['model'], 'provider': brain['provider'], 'base_url': brain['base_url']}
    config['fallback_providers'] = []
    for field in ('fallback_model', 'fallback', 'fallbacks'):
        config.pop(field, None)
    config['delegation'].update(model=brain['model'], provider=brain['provider'], base_url=brain['base_url'])
    for field in ('api_key', 'fallback_providers'):
        config['delegation'].pop(field, None)
    auxiliary = config.setdefault('auxiliary', {})
    if 'vision' in roles:
        vision = roles['vision']
        auxiliary['vision'] = {'model': vision['model'], 'provider': vision['provider'], 'base_url': vision['base_url']}
    else:
        auxiliary['vision'] = {'enabled': False}
    return roles


def initialize(home, integration, product_config):
    native = yaml.safe_load(product_config.read_text())
    config_file = home / 'config.yaml'
    original_config = config_file.read_bytes() if config_file.exists() else None
    config = compose_config(native, yaml.safe_load(original_config) if original_config else {})
    roles = single_host_models(config)
    single_host = os.environ.get('PAIOS_DEPLOYMENT') == 'single-host'
    if os.environ.get('PAIOS_STAGE') != 'staging':
        # Upstream setup seeds this key even for fresh homes. Hermes dotenv
        # overrides the mounted key injected by hermes-start, breaking gateway auth.
        env_file = home / '.env'
        if env_file.exists():
            original = env_file.read_bytes()
            retained = b''.join(line for line in original.splitlines(keepends=True)
                if not re.match(rb'^[ \t]*(?:export[ \t]+)?API_SERVER_KEY[ \t]*=', line))
            if retained != original:
                env_file.write_bytes(retained)
    if os.environ.get('PAIOS_STAGE') == 'staging':
        backups = home / 'backups'
        backups.mkdir(exist_ok=True)
        os.chown(backups, 10000, 10000)
        for name in ('.env', '.op.env'):
            path = home / name
            if path.exists() and path.stat().st_size:
                path.rename(backups / f'{name}.pre-staging-{time.time_ns()}')
        (home / '.env').write_text('')
        os.chmod(home / '.env', 0o600)
        os.chown(home / '.env', 10000, 10000)
        plugins = home / 'plugins'
        if plugins.exists():
            for path in plugins.iterdir():
                if path.name == 'personal_aios' and path.is_symlink() and path.resolve() == integration.resolve():
                    continue
                path.rename(backups / f'plugin-{path.name}.pre-staging-{time.time_ns()}')
    # Imported native launch flags must not bypass cloud consent or move file writes.
    policy = {'HERMES_YOLO_MODE', 'HERMES_WRITE_SAFE_ROOT'}
    for name in ('.env', '.op.env'):
        path = home / name
        if path.exists() and (flags := policy.intersection(dotenv_values(path, interpolate=False))):
            backups = home / 'backups'
            backups.mkdir(exist_ok=True)
            os.chown(backups, 10000, 10000)
            saved = backups / f'{name}.pre-workshop-{time.time_ns()}'
            path.rename(saved)
            path.write_bytes(saved.read_bytes())
            for key in flags:
                unset_key(path, key)
            path.chmod(0o600)
            os.chown(path, 10000, 10000)
    config.setdefault('personal_aios', {}).update(
        internal_base_url=f"http://127.0.0.1:{os.environ['PAIOS_INTEGRATION_PORT']}",
        internal_key_file='/run/secrets/hermes-internal.key')
    shared_skills = str(integration / 'shared-skills')
    config['skills']['external_dirs'] = [str(integration / 'errands'), shared_skills]
    if single_host:
        disabled = set(config['skills'].get('disabled', []))
        if os.environ.get('PAIOS_ENABLE_WECHAT', '0') == '1':
            disabled.discard('wechat')
        else:
            disabled.add('wechat')
        config['skills']['disabled'] = sorted(disabled)
    config['terminal'] = {'backend': 'ssh', 'ssh_host': os.environ['PAIOS_WORKSHOP_HOST'],
        'ssh_user': 'root', 'ssh_port': 2222, 'ssh_key': str(home / 'workshop-ssh/owner_ed25519'),
        'cwd': '/workshop', 'ssh_isolated': True}
    authorized = []
    for name, command in [('id_ed25519', '/usr/local/bin/workshop-scope'),
                          ('owner_ed25519', '/usr/local/bin/workshop-scope --offline')]:
        key = home / 'workshop-ssh' / name
        key.parent.mkdir(mode=0o700, exist_ok=True)
        if not key.exists():
            subprocess.run(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', str(key)], check=True)
        for path in (key.parent, key, key.with_suffix('.pub')):
            os.chown(path, 10000, 10000)
        authorized.append(f'restrict,command="{command}" '.encode() + key.with_suffix('.pub').read_bytes())
    (ACCESS / 'authorized_keys').write_bytes(b''.join(authorized))
    os.chmod(ACCESS / 'authorized_keys', 0o644)
    spec = importlib.util.spec_from_file_location('paios_cron_policy', integration / 'cron.py')
    policy = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(policy)
    growth = policy.GROWTH_TOOLSETS
    # Replace imported Mac commands with image-owned MCP servers.
    config['mcp_servers'] = {'mijia': {'command': '/opt/hermes/.venv/bin/python',
        'args': [str(integration / 'mijia.py')], 'env': {'HERMES_HOME': str(home)}, 'timeout': 120}}
    provider = os.environ.get('PAIOS_PHONE_PROVIDER', 'off' if single_host else 'agentbay')
    phone_factory = PHONE_PROVIDERS[provider]
    if os.environ.get('PAIOS_STAGE') == 'staging':
        if provider != 'off':
            config['mcp_servers']['phone'] = {'command': '/opt/hermes/.venv/bin/python',
                'args': [str(integration / 'staging/fake_phone.py')],
                'env': {'PAIOS_FAKE_PHONE_LOG': str(home / 'fake-phone.jsonl'),
                        'PAIOS_ERRAND_SPOOL': '/var/lib/paios/state/errands'}, 'timeout': 120}
        config['mcp_servers']['mijia']['args'] = [str(integration / 'staging/fake_mijia.py')]
        config['mcp_servers']['mijia']['env']['PAIOS_FAKE_MIJIA_LOG'] = str(home / 'fake-mijia.jsonl')
        policy.isolate_staging_jobs(home)
        os.chown(home / '.paios-cloud-staging-v2', 10000, 10000)
        if (home / 'cron/jobs.json').exists():
            os.chown(home / 'cron/jobs.json', 10000, 10000)
        config['platform_toolsets']['api_server'] = list(policy.STAGING_API_TOOLSETS)
        config['platform_toolsets']['api_server_background'] = list(policy.staging_toolsets())
        config['platform_toolsets']['cron'] = list(policy.staging_toolsets())
        config.setdefault('agent', {})['disabled_toolsets'] = ['browser', 'computer_use', 'connections', 'homeassistant', 'discord', 'discord_admin', 'yuanbao', 'feishu_drive', 'spotify', 'tts', 'messaging']
    else:
        phone = phone_factory(home, integration, provider)
        if phone is not None:
            config['mcp_servers']['phone'] = phone
    if single_host and os.environ.get('PAIOS_ENABLE_MIHOME', '0') != '1':
        config['mcp_servers'].pop('mijia', None)
    desktop_enabled = json.loads(Path(os.environ['PAIOS_PRODUCT_CONFIG']).read_text()).get('desktop', {}).get('enabled') is True
    if single_host and os.environ.get('PAIOS_ENABLE_OWNER_MAC', '0') != '1':
        desktop_enabled = False
    if desktop_enabled:
        config['mcp_servers']['desktop'] = {
            'url': f"http://127.0.0.1:{os.environ['PAIOS_INTEGRATION_PORT']}/internal/desktop/mcp",
            'headers': {'Authorization': 'Bearer ${PAIOS_HERMES_INTERNAL_KEY}'},
            'timeout': 330, 'connect_timeout': 10, 'trust': 'full'}
    if desktop_enabled:
        config['mcp_servers']['owner_mac'] = {
            'command': '/opt/hermes/.venv/bin/python', 'args': [str(integration / 'owner_mac.py')],
            'env': {'PAIOS_INTEGRATION_PORT': os.environ['PAIOS_INTEGRATION_PORT'],
                    'PAIOS_OWNER_MAC_FILES': str(home / 'cache/owner-mac')},
            'timeout': 330, 'trust': 'full'}
        config.setdefault('computer_use', {}).update(backend='cua', no_overlay=False)
        if 'disabled_toolsets' in config['agent']:
            config['agent']['disabled_toolsets'] = [name for name in config['agent']['disabled_toolsets'] if name != 'computer_use']
        for platform in ('api_server', 'api_server_background'):
            config['platform_toolsets'][platform] = [*config['platform_toolsets'][platform], 'owner_mac']
    config['mcp_servers']['self'] = {
        'url': f"http://127.0.0.1:{os.environ['PAIOS_INTEGRATION_PORT']}/internal/self/mcp",
        'headers': {'Authorization': 'Bearer ${PAIOS_HERMES_INTERNAL_KEY}'},
        'timeout': 15, 'connect_timeout': 10, 'trust': 'full'}
    if single_host:
        unavailable = {name for name in ('phone', 'mijia', 'owner_mac') if name not in config['mcp_servers']}
        if 'vision' not in roles:
            unavailable.add('vision')
        for platform, tools in config['platform_toolsets'].items():
            config['platform_toolsets'][platform] = [name for name in tools if name not in unavailable]
    grantable = ['desktop', 'terminal', 'file']
    config['personal_aios']['grantable_toolsets'] = grantable
    for platform, tools in config['platform_toolsets'].items():
        config['platform_toolsets'][platform] = [name for name in tools if name not in grantable]
    if 'disabled_toolsets' in config['agent']:
        config['agent']['disabled_toolsets'] = [name for name in config['agent']['disabled_toolsets'] if name not in grantable]
    # Tool visibility is not authorization: children inherit the admitted scope and grants.
    conversation = ['memory', 'session_search', 'skills', 'delegation', 'kanban']
    execution = set(grantable) | set(config['mcp_servers']) | {'skills_hub', 'code_execution', 'effects'}
    if desktop_enabled:
        execution.add('computer_use')
    for platform in ('api_server', 'api_server_background', 'cron'):
        execution.update(config['platform_toolsets'].get(platform, []))
        config['platform_toolsets'][platform] = list(conversation)
    config['personal_aios']['delegated_toolsets'] = sorted(execution)
    if single_host and 'phone' in config['mcp_servers'] and os.environ.get('PAIOS_STAGE') != 'staging':
        for role in ('executor_fast', 'executor_thorough'):
            if role not in roles:
                raise ValueError('Phone requires ' + ', '.join(f'PAIOS_{role.upper()}_{field}' for field in ('MODEL', 'BASE_URL', 'API_KEY')))
        phone_config = yaml.safe_load((integration.parents[1] / 'connectors/phone_executor/mobilerun-config.example.yaml').read_text())
        phone_env = config['mcp_servers']['phone']['env']
        for name, profile in phone_config['llm_profiles'].items():
            role = 'executor_thorough' if name == 'thorough' else 'executor_fast'
            route = roles[role]
            variable = f'PAIOS_{role.upper()}_KEY_FILE'
            profile.update(provider='OpenAILike', model=route['model'], base_url=route['base_url'],
                kwargs={'is_chat_model': True, 'is_function_calling_model': True, 'api_key_file_env': variable})
            phone_env[variable] = route['key_file']
        path = home / 'mobilerun-config.yaml'
        path.touch(mode=0o600, exist_ok=True)
        path.write_text(yaml.safe_dump(phone_config, sort_keys=False))
        path.chmod(0o600)
        os.chown(path, 10000, 10000)
        phone_env['PAIOS_MOBILERUN_CONFIG'] = str(path)
    if 'phone' in config['mcp_servers']:
        config['mcp_servers']['phone']['env'].update(
            PAIOS_PAYMENT_URL=f"http://127.0.0.1:{os.environ['PAIOS_INTEGRATION_PORT']}",
            PAIOS_PAYMENT_KEY_FILE=str(SECRETS / 'payment-executor.key'))
    for server in config['mcp_servers'].values():
        server.setdefault('tools', {}).update(resources=False, prompts=False)
    # A native profile is the data boundary: only model transport and build machinery cross.
    build_home = home / 'workshop'
    build_home.mkdir(mode=0o700, exist_ok=True)
    build = {field: copy.deepcopy(config[field]) for field in
        ('model', 'providers', 'custom_providers', 'fallback_providers', 'auxiliary', 'network',
         'terminal', 'security', 'approvals') if field in config}
    if 'workshop_repair' in roles:
        repair = roles['workshop_repair']
        build['model'] = {'default': repair['model'], 'provider': repair['provider'], 'base_url': repair['base_url']}
    build['terminal']['ssh_key'] = str(home / 'workshop-ssh/id_ed25519')
    build['agent'] = {key: native['agent'][key] for key in ('max_tool_calls', 'tool_call_milestone_interval')}
    build['delegation'] = copy.deepcopy(config['delegation'])
    if 'workshop_repair' in roles:
        build['delegation'].update(model=repair['model'], provider=repair['provider'], base_url=repair['base_url'])
    build['plugins'] = {'enabled': ['personal_aios'], 'entries': {'personal_aios': {'allow_tool_override': True}}}
    build['personal_aios'] = {key: config['personal_aios'][key] for key in ('internal_base_url', 'internal_key_file')}
    build['personal_aios']['grantable_toolsets'] = []
    if os.environ.get('PAIOS_BUILDER_URL'):
        build['personal_aios'].update(builder_url=os.environ['PAIOS_BUILDER_URL'],
            builder_token_file=os.environ.get('PAIOS_BUILDER_TOKEN_FILE', '/run/secrets/workshop-builder.key'),
            builder_ca_file=os.environ.get('PAIOS_BUILDER_CA_FILE', '/run/secrets/workshop-builder.crt'))
        # Remote builder requests own their HTTP deadlines; keep waiting for their bounded result.
        build['timeouts'] = {'tools': {'sequential_call': 0, 'concurrent_batch': 0}}
        # Remote development leaves this profile as discovery and release control.
        growth = [tool for tool in growth if tool not in {'terminal', 'file', 'code_execution'}]
    build.update(memory={'provider': 'personal_aios', 'memory_enabled': False, 'user_profile_enabled': False},
        skills={'external_dirs': [shared_skills], 'inline_shell': False, 'create_dir': '', 'guard_agent_created': True},
        tools={'tool_search': {'enabled': 'off'}}, platform_toolsets={'api_server_build': growth},
        sync={'enabled': False})
    (build_home / 'config.yaml').write_text(yaml.safe_dump(build, allow_unicode=True, sort_keys=False))
    (build_home / 'plugins').mkdir(exist_ok=True)
    bind_image_path(build_home / 'plugins/personal_aios', integration)
    for path in (build_home, build_home / 'config.yaml', build_home / 'plugins'):
        os.chown(path, 10000, 10000)
    # Always use the persona shipped with the plugin, including imported regular
    # SOUL files. Preserve owner files before rebinding, without overwriting backups.
    (home / 'plugins').mkdir(parents=True, exist_ok=True)
    bind_image_path(home / 'plugins/personal_aios', integration)
    bind_image_path(home / 'SOUL.md', integration / 'persona/yimi.md')
    rendered = yaml.safe_dump(config, allow_unicode=True, sort_keys=False).encode()
    if original_config is not None and original_config != rendered:
        backups = home / 'backups'
        backups.mkdir(exist_ok=True)
        os.chown(backups, 10000, 10000)
        saved = backups / f'config.yaml.pre-cloud-{time.time_ns()}'
        saved.touch(mode=0o600)
        saved.write_bytes(original_config)
        os.chown(saved, 10000, 10000)
    config_file.write_bytes(rendered)
    # The upstream s6 hook initializes permissions before this hook.
    for path in [home / 'plugins', config_file]:
        os.chown(path, 10000, 10000)


if __name__ == '__main__':
    home = Path(os.environ['HERMES_HOME'])
    product_config = Path('/opt/paios/hermes-product-config.yaml')
    if sys.argv[1:] == ['--seed-only']:
        seed_config(home, product_config)
    elif not sys.argv[1:]:
        initialize(home, Path('/opt/paios/integrations/hermes/personal_aios'), product_config)
    else:
        raise ValueError('Usage: hermes-init.py [--seed-only]')

"""Translate first-run model inputs to the existing settings import contract."""
import argparse
import json
import os
from pathlib import Path

ROLES = ('brain', 'vision', 'executor_fast', 'executor_thorough', 'realtime', 'tts', 'workshop_repair')
NATIVE_ROLES = ('brain', 'vision', 'workshop_repair')


def configured_roles():
    result = {}
    for role in ROLES:
        prefix = 'PAIOS_' + role.upper()
        model = os.environ.get(prefix + '_MODEL', '')
        if not model and role != 'brain':
            continue
        result[role] = {'model': model, 'base_url': os.environ.get(prefix + '_BASE_URL', ''),
                        'provider': 'single-host-' + role.replace('_', '-'),
                        'key_file': '/run/secrets/role-' + role.replace('_', '-') + '.key'}
    return result


def snapshot(roles):
    budget = {field: int(os.environ['PAIOS_BRAIN_' + field.upper()])
              for field in ('context_limit', 'max_output_tokens')}
    providers = [{'id': value['provider'], 'display_name': role.replace('_', ' '),
                  'wire_protocol': 'chat_completions', 'base_url': value['base_url'],
                  'credential_ref': value['provider']}
                 for role, value in roles.items() if role in NATIVE_ROLES]
    routes = []
    native_roles = json.loads(Path(__file__).with_name('model-settings-import.example.json').read_text())['roles']
    for profile, main, selection, boundary in [('owner', 'brain', 'brain', 'brain_idle'),
                                              ('workshop', 'build.workshop',
                                               'workshop_repair' if 'workshop_repair' in roles else 'brain', 'build_idle')]:
        value = roles[selection]
        routes.append({'id': main, 'profile': profile, 'provider_ref': value['provider'],
                       'model_id': value['model'], 'parameters': budget,
                       'ordered_fallbacks': [], 'activation_boundary': boundary})
        for role in ('delegation', 'cron') if profile == 'owner' else ('delegation', 'build.repair'):
            routes.append({'id': role, 'profile': profile, 'inherit_from': main, 'parameters': {},
                           'ordered_fallbacks': [], 'activation_boundary': boundary})
        # Preserve native side-task identities and parameters, without importing any example provider route.
        for role in native_roles:
            if role['profile'] != profile or not (role['id'].startswith('auxiliary.') or role['id'] == 'call.intent'):
                continue
            if role['id'] == 'auxiliary.vision':
                continue
            routes.append({'id': role['id'], 'profile': profile, 'parameters': role['parameters'],
                           'ordered_fallbacks': [], 'activation_boundary': boundary,
                           **({'disabled': True} if role.get('disabled') else {'inherit_from': main})})
        if 'vision' in roles:
            value = roles['vision']
            routes.append({'id': 'auxiliary.vision', 'profile': profile, 'provider_ref': value['provider'],
                           'model_id': value['model'], 'parameters': {},
                           'ordered_fallbacks': [], 'activation_boundary': boundary})
    return {'providers': providers, 'roles': routes}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--keys', type=Path, required=True)
    args = parser.parse_args()
    # The caller pipes this directly to model-settings-project.ts --keys-stdin.
    print(json.dumps({value['provider']: (args.keys / Path(value['key_file']).name).read_text().strip()
                      for role, value in configured_roles().items() if role in NATIVE_ROLES}))

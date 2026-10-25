"""The cloud renderer's single production-to-staging isolation boundary."""
from copy import deepcopy

EXTERNAL_RESOURCES = ('bark_device_file', 'bark_key_file', 'avatar_url', 'video_call', 'vidu_cleanup_key_file')


BUILD_TARGET = ('build_profile', 'build_activation_url', 'build_ca_file')


def contract_config(config):
    """Project out only the renderer's deliberately different structural boundaries."""
    value = deepcopy(config)
    value.pop('archive_tiering', None)
    for key in BUILD_TARGET:
        value.get('model_settings', {}).pop(key, None)
    for key in (*EXTERNAL_RESOURCES, 'staging_effect_sink_file'):
        value['product_resources'].pop(key, None)
    return value


def render(production, authority, livekit_api_url, builder_url=None):
    staging = deepcopy(production)
    if 'model_settings' in staging:
        # Staging activates only its own remote builder; production's build target never crosses.
        for key in BUILD_TARGET:
            staging['model_settings'].pop(key, None)
        if builder_url:
            staging['model_settings'].update(build_profile='builder', build_activation_url=builder_url,
                                             build_ca_file='${PAIOS_SECRET_ROOT}/workshop-builder.crt')
    staging['payment'].update(enabled=False, staging=True)
    staging.pop('archive_tiering', None)
    resources = staging['product_resources']
    resources['postgres']['host'] = 'postgres-staging'
    resources.update(public_api_url='https://' + authority, livekit_url='wss://' + authority,
                     livekit_api_url=livekit_api_url, legacy_public_api_urls='')
    for key in EXTERNAL_RESOURCES:
        resources.pop(key, None)
    resources['staging_effect_sink_file'] = '${PAIOS_DATA_ROOT}/state/staging-effects.jsonl'
    return staging

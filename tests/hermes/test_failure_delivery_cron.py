"""Native cron failure classification survives its existing product delivery path."""
import asyncio
from types import SimpleNamespace

import pytest

from integrations.hermes.personal_aios import cron


@pytest.mark.asyncio
@pytest.mark.parametrize('warnings_enabled', [True, False])
async def test_failed_native_script_enters_main_agent_instead_of_only_notifying_owner(monkeypatch, tmp_path, warnings_enabled):
    from cron.jobs import claim_job_for_fire, create_job, get_job
    from cron.scheduler import run_one_job
    from gateway.config import Platform, PlatformConfig
    from gateway.platform_registry import PlatformEntry, platform_registry
    from hermes_constants import reset_hermes_home_override, set_hermes_home_override

    monkeypatch.delenv('PAIOS_STAGE', raising=False)
    monkeypatch.setattr('gateway.warning_notifications.warning_notifications_enabled', lambda *args: warnings_enabled)
    owner = {'principal_id': 'fixture-owner', 'device_id': 'fixture-phone',
             'origin_processed_event_id': 'd:owner-request'}
    deliveries = []
    def request(path, body):
        deliveries.append((path, body))
        return {'status': 'admitted' if path.endswith('scheduled-task') else 'delivered'}
    ctx = SimpleNamespace(register_tool=lambda *args, **kwargs: True,
        register_platform=lambda name, label, factory, check, **kwargs: platform_registry.register(
            PlatformEntry(name=name, label=label, adapter_factory=factory, check_fn=check, **kwargs)),
        register_platform_handler=lambda *args, **kwargs: None)
    token = set_hermes_home_override(tmp_path)
    try:
        cron.register(ctx, SimpleNamespace(_request=request))
        (tmp_path / 'config.yaml').write_text('cron: {wrap_response: false}\nplatforms: {personal_aios: {enabled: true}}\n')
        (tmp_path / 'scripts/fail.py').write_text('raise RuntimeError("fake model step 1 stalled")\n')
        adapter = platform_registry.create_adapter('personal_aios', PlatformConfig(enabled=True))
        job = create_job(prompt='只读检查报价', name='定时查价格', schedule='in 1m',
                         deliver=cron.target(owner), script='fail.py', no_agent=True)
        claimed = claim_job_for_fire(job['id'], manual=True, return_job=True)
        assert await asyncio.to_thread(run_one_job, claimed, adapters={Platform('personal_aios'): adapter},
                                          loop=asyncio.get_running_loop())
        assert len(deliveries) == 1
        path, body = deliveries[0]
        assert path == '/internal/hermes/scheduled-task'
        assert body['failure']['title'] == '定时查价格'
        assert body['failure']['terminal_reason'] == 'failed'
        assert body['failure']['failure_source'] == 'cron'
        assert 'Script exited with code 1' in body['failure']['answer']
        assert body['failure']['evidence_ref'] == {'tool': 'cronjob_manage', 'action': 'list', 'job_id': job['id']}
        assert body['origin_processed_event_id'] == owner['origin_processed_event_id']
        assert get_job(job['id'])['last_status'] == 'error'
        from tools.cronjob_tools import _format_job
        assert 'fake model step 1 stalled' in _format_job(get_job(job['id']))['last_error']
    finally:
        platform_registry.unregister('personal_aios')
        reset_hermes_home_override(token)

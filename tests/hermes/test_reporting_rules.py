"""One product reporting contract reaches main and selfcheck native prompts."""
from pathlib import Path
from types import SimpleNamespace
from test_skill_authority import profile
from test_consent_nonblocking import consent
import pytest


PRODUCT = Path(__file__).parents[2] / 'integrations/hermes/personal_aios'


def test_shared_reporting_contract_reaches_native_parent_and_child(profile, monkeypatch):
    from hermes_cli import plugins
    from integrations.hermes import personal_aios
    from run_agent import AIAgent
    from tools.delegate_tool_progress import _build_child_system_prompt
    manager = plugins.PluginManager()
    manager._discovered = True
    context = plugins.PluginContext(plugins.PluginManifest(
        name='personal_aios', key='personal_aios', source='user'), manager)
    personal_aios.register(SimpleNamespace(
        register_memory_provider=lambda *a: None, register_tool=lambda *a, **kw: True,
        register_hook=lambda *a: None, register_middleware=lambda *a: None,
        register_platform=lambda *a, **kw: None,
        register_platform_handler=lambda *a: None,
        register_system_prompt_section=context.register_system_prompt_section))
    monkeypatch.setattr(plugins, '_plugin_manager', manager)
    heading = '### 只报告记录支持的事实'
    main = (PRODUCT / 'skills/personal-aios-main/SKILL.md').read_text()
    rules = (heading + main.split(heading, 1)[1].split('\n### ', 1)[0]).strip()
    for task in ('', _build_child_system_prompt('自检：投递报告')):
        agent = AIAgent(api_key='fixture', base_url='http://127.0.0.1:1/v1', model='fixture',
                        platform='api_server', enabled_toolsets=[], skip_context_files=True,
                        skip_memory=True, skip_background_review=True, quiet_mode=True,
                        ephemeral_system_prompt=task or None)
        try:
            assert agent._build_system_prompt().count(rules) == 1
        finally:
            agent.close()
    for file in ('skills/personal-aios-main/SKILL.md', 'errands/failure-selfcheck/SKILL.md'):
        assert '只报告记录支持的事实' in (PRODUCT / file).read_text()


@pytest.mark.parametrize('consent', ['general-first', 'memory-first'], indirect=True)
def test_native_dual_loader_owns_one_shared_reporting_section(consent):
    sections = [section for section in consent.manager.render_system_prompt_sections({})
                if section.id == 'personal-aios.reporting']
    assert len(sections) == 1
    assert '只报告记录支持的事实' in sections[0].content
    assert consent.manager.unload('personal_aios')
    assert consent.manager.render_system_prompt_sections({}) == []
    assert not consent.manager._memory_hook_registrations

"""Real native skill loading and mutation against image skills and writable profiles."""
import json
from pathlib import Path
import posixpath
import re
import subprocess
from types import SimpleNamespace

import pytest
import yaml

ROOT = Path(__file__).parents[2]
PRODUCT = ROOT / 'integrations/hermes/personal_aios'


@pytest.fixture
def profile(tmp_path, monkeypatch):
    from hermes_constants import set_hermes_home_override, reset_hermes_home_override
    home = tmp_path / 'home'
    (home / 'plugins').mkdir(parents=True)
    (home / 'plugins/personal_aios').symlink_to(PRODUCT, target_is_directory=True)
    (home / 'config.yaml').write_text(yaml.safe_dump({'skills': {
        'external_dirs': [str(PRODUCT / 'errands'), str(PRODUCT / 'shared-skills')],
        'inline_shell': False, 'create_dir': ''}}))
    token = set_hermes_home_override(home)
    try:
        yield home
    finally:
        reset_hermes_home_override(token)


def manage(action, name='cloud-phone', **kwargs):
    from tools.skill_manager_tool import skill_manage
    return json.loads(skill_manage(action, name, **kwargs))


def test_model_facing_persona_and_skills_do_not_expose_internal_turn_exit_reason():
    for path in [*PRODUCT.glob('persona/**/*.md'), *PRODUCT.rglob('SKILL.md')]:
        assert 'delegation_waiting' not in path.read_text(), str(path.relative_to(PRODUCT))


def test_model_facing_undo_instructions_do_not_teach_a_fixed_trigger(monkeypatch):
    monkeypatch.syspath_prepend(str(PRODUCT.parent))
    from personal_aios import workshop
    texts = {str(path.relative_to(PRODUCT)): path.read_text()
             for path in [*PRODUCT.glob('persona/**/*.md'), *PRODUCT.rglob('SKILL.md')]}
    schemas = {}
    workshop.register(SimpleNamespace(register_tool=lambda name, toolset, schema, fn: schemas.update({name: schema})))
    texts['skills_hub'] = json.dumps(schemas['skills_hub'], ensure_ascii=False)
    assert not [name for name, text in texts.items() if '改回去' in text]


def test_phone_closeout_rules_reach_native_skill_readers(profile):
    from tools.skills_tool import skill_view
    from tools.delegate_tool_progress import _build_child_system_prompt
    main = (PRODUCT / 'skills/personal-aios-main/SKILL.md').read_text()
    cloud = json.loads(skill_view('cloud-phone'))['content']
    child = _build_child_system_prompt('核对手机跑腿', context=cloud)
    for text in (main, child):
        assert '已开始，job_id=X；结果将以 errand_result 返回' in text
        assert '没有证据，不推断结果或首次确认仍待处理' in text
        assert 'phone_status' in text and '最近 600 秒' in text
    assert 'errand_result 和 approval decision 是权威记录' in main
    assert 'confirmation_receipts' in main
    assert '只报告记录支持的事实' in main
    assert 'tool_trace' in main and '不包含工具结果原文' in main
    assert 'context' in main and '先读取 cloud-phone' in main



def test_office_edit_method_reaches_native_skill_readers(profile):
    from tools.skills_tool import skill_view
    batch = json.loads(skill_view('code-batch-operation'))['content']
    desktop = json.loads(skill_view('desktop-assistant'))['content']
    main = (PRODUCT / 'skills/personal-aios-main/SKILL.md').read_text()
    for phrase in ('### 修改已有 Office 文件', 'load_workbook(原文件)', '不手拼 zip', '`styles.xml`、theme、`workbook.xml`',
                   'Calibri 11、family 2、主题色 1、scheme minor', '不静默丢失', '只比较原 Sheet 的 XML 不够',
                   '日期基准（date1904）', '逐字节相同、经库重写但语义相同'):
        assert phrase in batch, phrase
    assert 'code-batch-operation' in desktop and '「修改已有 Office 文件」' in main
    assert 'zipfile' not in main and '保留原 Sheet 的 XML' not in main

@pytest.mark.parametrize('product', ['cloud-phone', 'code-batch-operation'])
def test_create_and_hub_cannot_take_product_name_or_frontmatter_alias(profile, product):
    from tools.skills_hub_install import install_from_quarantine, quarantine_bundle
    from tools.skills_hub_models import SkillBundle
    from tools.skills_guard import scan_skill
    from tools.skills_tool import skill_view
    original = Path(json.loads(skill_view(product))['_source_path']).read_text()
    for name, content in [(product, original), ('another-name', original)]:
        for category in (None, 'errands', 'workshop'):
            result = manage('create', name, content=content, category=category)
            assert not result['success'] and 'self-release' in result['error'], result
        bundle = SkillBundle(name, {'SKILL.md': content}, 'official', 'fixture/' + name, 'builtin')
        quarantine = quarantine_bundle(bundle)
        with pytest.raises(ValueError, match='self-release'):
            install_from_quarantine(quarantine, name, 'errands', bundle, scan_skill(quarantine))
        assert quarantine.exists()  # Refusal precedes moving or deleting any target.
    from agent.skill_utils import iter_skill_index_files
    assert not list(iter_skill_index_files(profile / 'skills', 'SKILL.md'))


def test_wechat_linked_index_resolves_all_bundled_mac_sources(profile):
    from tools.skills_tool import skill_view
    skill = json.loads(skill_view('wechat'))
    index_path = 'references/scripts.md'
    assert index_path in skill['linked_files']['references']
    index = json.loads(skill_view('wechat', file_path=index_path))
    assert index['success'], index
    targets = {posixpath.normpath('references/' + target)
               for target in re.findall(r'\]\(([^)]+)\)', index['content'])}
    root = PRODUCT / 'errands/wechat'
    assert targets == {str(path.relative_to(root)) for path in (root / 'scripts').glob('*.swift')} | {
        'references/wechat-bridge-mac-LICENSE'}
    for target in targets:
        loaded = json.loads(skill_view('wechat', file_path=target))
        assert loaded['success'], loaded
        assert loaded['content'] == (root / target).read_text()


@pytest.mark.parametrize('origin', ['user', 'background_review'])
@pytest.mark.parametrize('action', ['edit', 'patch', 'batch'])
def test_product_improvements_are_applicable_release_patches(profile, tmp_path, origin, action):
    from tools.skills_tool import skill_view
    from tools.skill_provenance import set_current_write_origin, reset_current_write_origin
    original = (PRODUCT / 'errands/cloud-phone/SKILL.md').read_text()
    old = '# 云手机'
    assert old in original
    new = old + '\n\n只有 phone_status stage=ready 才算恢复完成，installing 返回 busy。'
    token = set_current_write_origin(origin)
    try:
        assert json.loads(skill_view('cloud-phone'))['success']  # Review reads the exact product source.
        if action == 'edit':
            result = manage(action, 'errands/cloud-phone', content=original.replace(old, new))
        elif action == 'patch':
            result = manage(action, 'errands/cloud-phone', old_string=old, new_string=new)
        else:
            result = manage('patch', operations=[
                {'action': 'patch', 'old_string': old, 'new_string': new},
                {'action': 'patch', 'old_string': 'installing 返回 busy', 'new_string': 'installing 仍返回 busy'}])
    finally:
        reset_current_write_origin(token)
    assert result['success'] and result['applied'] is False, result
    patch = Path(result['release_candidate'])
    assert patch.is_file() and 'self-release' in result['message']
    assert result['patch'] == patch.read_text()
    assert json.loads(patch.with_name('reason.json').read_text())['origin'] == origin
    assert not list((profile / 'skills').rglob('SKILL.md'))
    assert (PRODUCT / 'errands/cloud-phone/SKILL.md').read_text() == original
    checkout = tmp_path / 'release-workspace'
    target = checkout / 'integrations/hermes/personal_aios/errands/cloud-phone/SKILL.md'
    target.parent.mkdir(parents=True)
    target.write_text(original)
    subprocess.run(['git', 'apply', str(patch)], cwd=checkout, check=True, capture_output=True)
    assert 'phone_status stage=ready' in target.read_text()
    assert ('installing 仍返回 busy' in target.read_text()) == (action == 'batch')


def test_all_product_skills_load_with_local_collisions_and_third_party_stays_ambiguous(profile):
    from tools.skills_tool import skill_view, _find_all_skills
    from tools.skill_manager_tool import _find_skill
    from tools.skill_product import product_dirs
    products = [p for root in product_dirs() for p in root.rglob('SKILL.md')]
    for path in products:
        local = profile / 'skills/errands' / path.parent.name / 'SKILL.md'
        local.parent.mkdir(parents=True, exist_ok=True)
        local.write_text(path.read_text().replace('description:', 'description: Local shadow ', 1) + '\nLocal shadow must not load.\n')
        result = json.loads(skill_view(path.parent.name))
        assert result['success'] and Path(result['_source_path']) == path, result
        assert _find_skill('errands/' + path.parent.name)['path'] == path.parent
        assert 'Local shadow' not in result['content']
    listed = {s['name']: s for s in _find_all_skills()}
    for path in products:
        name = yaml.safe_load(path.read_text().split('---')[1])['name']
        assert 'Local shadow' not in listed[name]['description'], listed[name]
    shadow = profile / 'skills/errands/cloud-phone/SKILL.md'
    saved = shadow.read_bytes()
    result = manage('patch', old_string='# 云手机', new_string='# 云手机\nProduct improvement.')
    assert result['success'] and result['applied'] is False, result
    assert shadow.read_bytes() == saved
    external = profile.parent / 'third-party'
    for root, text in [(profile / 'skills', 'local'), (external, 'external')]:
        path = root / 'third-party/SKILL.md'
        path.parent.mkdir(parents=True)
        path.write_text('---\nname: third-party\ndescription: Independent procedure.\n---\n' + text)
    config = yaml.safe_load((profile / 'config.yaml').read_text())
    config['skills']['external_dirs'].append(str(external))
    (profile / 'config.yaml').write_text(yaml.safe_dump(config))
    # New profile identity reloads native config without touching the real user's config.
    from hermes_constants import set_hermes_home_override, reset_hermes_home_override
    token = set_hermes_home_override(profile)
    try:
        result = json.loads(skill_view('third-party'))
        assert not result['success'] and 'Ambiguous skill name' in result['error'], result
    finally:
        reset_hermes_home_override(token)


def test_ordinary_learning_is_immediate_and_profile_bound(profile, tmp_path):
    from hermes_constants import set_hermes_home_override, reset_hermes_home_override
    from tools.skills_tool import skill_view
    content = '---\nname: new-method\ndescription: Use a new method.\n---\nFirst draft.\n'
    assert manage('create', 'new-method', content=content)['success']
    assert manage('patch', 'new-method', old_string='First draft.', new_string='Improved.')['success']
    assert 'Improved.' in json.loads(skill_view('new-method'))['content']
    renamed = manage('patch', 'new-method', old_string='name: new-method', new_string='name: cloud-phone')
    assert not renamed['success'] and 'self-release' in renamed['error']
    assert 'name: new-method' in (profile / 'skills/new-method/SKILL.md').read_text()
    other = tmp_path / 'other'
    other.mkdir()
    (other / 'config.yaml').write_text('skills: {external_dirs: []}\n')
    token = set_hermes_home_override(other)
    try:
        assert manage('create', 'cloud-phone', content=content.replace('new-method', 'cloud-phone'))['success']
    finally:
        reset_hermes_home_override(token)
    assert Path(json.loads(skill_view('cloud-phone'))['_source_path']).is_relative_to(PRODUCT)


def test_product_batch_rejects_clobber_and_invalid_shape_without_a_partial_proposal(profile):
    original = (PRODUCT / 'errands/cloud-phone/SKILL.md').read_text()
    result = manage('patch', operations=[
        {'action': 'patch', 'name': 'cloud-phone', 'old_string': '# 云手机', 'new_string': '# 云手机\nImprovement A.'},
        {'action': 'patch', 'name': 'errands/cloud-phone', 'content': original + '\nImprovement B.\n'}])
    assert not result['success'] and 'silently discard' in result['error'], result
    result = manage('patch', operations={'action': 'patch'}, old_string='# 云手机', new_string='# changed')
    assert not result['success'] and 'non-empty array' in result['error'], result
    assert not (profile / 'release-workspace').exists()


def test_background_product_attachment_proposal_can_add_a_new_file(profile, tmp_path):
    from tools.skill_provenance import BACKGROUND_REVIEW, set_current_write_origin, reset_current_write_origin
    token = set_current_write_origin(BACKGROUND_REVIEW)
    try:
        result = manage('write_file', file_path='references/learned-step.md', file_content='A new procedure.\n')
    finally:
        reset_current_write_origin(token)
    assert result['success'] and not result['applied'], result
    patch = Path(result['release_candidate'])
    assert patch.read_text() == result['patch']
    checkout = tmp_path / 'release-workspace'
    checkout.mkdir()
    subprocess.run(['git', 'apply', str(patch)], cwd=checkout, check=True, capture_output=True)
    target = checkout / 'integrations/hermes/personal_aios/errands/cloud-phone/references/learned-step.md'
    assert target.read_text() == 'A new procedure.\n'
    assert not list((profile / 'skills').rglob('SKILL.md'))

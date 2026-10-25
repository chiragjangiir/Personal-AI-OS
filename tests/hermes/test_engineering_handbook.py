"""The owner's capability architecture precedes the engineering procedures."""
from pathlib import Path


def test_supreme_rule_precedes_handbook_procedures():
    handbook = (Path(__file__).resolve().parents[2] /
        'integrations/hermes/personal_aios/shared-skills/engineering-handbook/SKILL.md').read_text()
    title = '## 至高规则：内核是内核，能力全在内核外（主人定，2026-10-24）'
    assert handbook.count(title) == 1
    start, end = handbook.index(title), handbook.index('## 1. 什么时候交给后台工坊')
    assert start < end
    section = handbook[start:end]
    assert all(f'\n{number}. ' in section for number in range(1, 7))
    for contract in ('Agent Plugins v1', 'plugin.json', 'yimi-gateway', '影响类别 9 类',
                     '回执 6 类事实', '不能声明「花钱」和「改依米自己」两类'):
        assert contract in section

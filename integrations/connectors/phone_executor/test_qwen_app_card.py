"""Load Qwen procedures through Mobilerun's real provider and exercise its read-only navigation primitive."""
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from mobilerun.app_cards.providers.local_provider import LocalAppCardProvider
from mobilerun.agent.tool_registry import ToolRegistry

import server


class QwenAppCard(unittest.IsolatedAsyncioTestCase):
    async def test_android_card_loads_with_working_order_route_and_minimum_order_procedure(self):
        provider = LocalAppCardProvider(str(Path(__file__).with_name('app_cards')))
        card = await provider.load_app_card('com.aliyun.tongyi', platform='android')
        self.assertIn('https://tb.ele.me/app/eleme/miniapp-plugin-orderlist/et-index/pages/index/index', card)
        self.assertIn('open_qwen_order_history', card)
        for label in ('起送价', '预计配送费', '进店选购', '选这个', '去凑单', '先问用户'):
            self.assertIn(label, card)

    async def test_order_navigation_uses_qwen_view_entry_and_returns_control_to_agent(self):
        registry = ToolRegistry()
        registry.register_from_dict(server.QWEN_TOOLS)
        shell = Mock(return_value='Status: ok')
        with patch.object(server, '_shell', shell):
            result = await registry.execute('open_qwen_order_history', {}, SimpleNamespace())
        self.assertTrue(result.success)
        shell.assert_called_once_with('am start -W -a android.intent.action.VIEW '
            '-n com.aliyun.tongyi/com.ucpro.MainActivity -d '
            'https://tb.ele.me/app/eleme/miniapp-plugin-orderlist/et-index/pages/index/index', True)

    async def test_navigation_failure_is_reported_without_repeating_launch(self):
        registry = ToolRegistry()
        registry.register_from_dict(server.QWEN_TOOLS)
        with patch.object(server, '_shell', side_effect=RuntimeError('Activity unavailable')) as shell:
            result = await registry.execute('open_qwen_order_history', {}, SimpleNamespace())
        self.assertFalse(result.success)
        self.assertIn('Activity unavailable', result.summary)
        shell.assert_called_once()

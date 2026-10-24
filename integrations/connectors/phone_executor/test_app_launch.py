"""Launch real apps through their resolved Activity, including headless Android."""
import contextlib
import base64
import json
import unittest
from unittest.mock import AsyncMock, Mock, patch
from mobilerun_core_local.driver.base import DeviceDisconnectedError

import server


class AppLaunch(unittest.IsolatedAsyncioTestCase):
    async def test_headless_launch_does_not_require_monkey_physical_keys(self):
        @contextlib.asynccontextmanager
        async def lease(*args, **kwargs):
            yield

        driver = AsyncMock()
        order = []

        def shell(command, *args, **kwargs):
            if command.startswith('monkey '):
                raise RuntimeError('SYS_KEYS has no physical keys but with factor 2.0%')
            order.append(command)
            return ''

        async def start(package):
            order.append(('start', package))

        async def agent(*args, **kwargs):
            self.assertEqual(order[-1], ('start', 'com.aliyun.tongyi'))
            return {'success': True, 'answer': 'query complete'}

        driver.start_app.side_effect = start
        with patch.object(server, '_errand', lease), patch.object(server, '_shell', shell), \
             patch.object(server, '_driver', AsyncMock(return_value=driver)), \
             patch.object(server, '_agent', agent), patch.object(server, 'PHONE_PROVIDER', 'mac-android'), \
             patch.object(server, '_observation', return_value=b'<hierarchy/>'), \
             patch.object(server.asyncio, 'sleep', AsyncMock()):
            result = await server._errand_task('只读查询', 10, None, None, None, '千问', 'thorough')
        self.assertTrue(result['success'])
        driver.start_app.assert_awaited_once_with('com.aliyun.tongyi')
        self.assertIn('am force-stop com.aliyun.tongyi', order)

    async def test_launch_failure_does_not_run_agent(self):
        @contextlib.asynccontextmanager
        async def lease(*args, **kwargs):
            yield

        driver = AsyncMock()
        driver.start_app.side_effect = RuntimeError('No launch Activity')
        agent = AsyncMock()
        with patch.object(server, '_errand', lease), patch.object(server, '_shell'), \
             patch.object(server, '_driver', AsyncMock(return_value=driver)), \
             patch.object(server, '_agent', agent), patch.object(server, '_preflight', return_value=False), \
             patch.object(server.asyncio, 'sleep', AsyncMock()):
            result = await server._errand_task('只读查询', 10, None, None, None, '千问', 'thorough')
        self.assertFalse(result['success'])
        self.assertIn('No launch Activity', result['answer'])
        agent.assert_not_awaited()


class ObservationReadiness(unittest.TestCase):
    def read(self, replies, *, until_timeout=False, error=False):
        session = server._Observations()
        session.process = Mock()
        process = session.process
        elapsed = 0
        def sleep(delay):
            nonlocal elapsed
            elapsed += delay
        def receive(*args):
            reply = replies[0] if until_timeout else replies.pop(0)
            return json.dumps(reply).encode() + b'\n'
        with patch.object(server.select, 'select', return_value=([1], [], [])), \
             patch.object(server.os, 'read', side_effect=receive), \
             patch.object(server.time, 'monotonic', side_effect=lambda: elapsed), \
             patch.object(server.time, 'sleep', side_effect=sleep):
            if error:
                with self.assertRaises(DeviceDisconnectedError) as failure:
                    session.request('tree')
                result = failure.exception
            else:
                result = session.request('tree')
            return result, process, elapsed

    def no_root(self):
        return dict(kind='error', stage='tree', detail='java.lang.IllegalStateException: No active UI root', elapsed_ms=16)

    def test_launch_window_may_become_readable_without_relaunch_or_portal_repair(self):
        xml = b'<hierarchy width="720" height="1280"><node package="com.aliyun.tongyi"/></hierarchy>'
        ready = dict(kind='tree', data=base64.b64encode(xml).decode(), elapsed_ms=16)
        result, process, elapsed = self.read([self.no_root(), self.no_root(), ready])
        self.assertEqual(base64.b64decode(result['data']), xml)
        self.assertGreater(elapsed, 0)
        self.assertTrue(all(call.args == (b'tree\n',) for call in process.stdin.write.call_args_list))
        process.kill.assert_not_called()

    def test_missing_root_has_a_bounded_readiness_wait_and_reports_the_original_failure(self):
        result, process, elapsed = self.read([self.no_root()], until_timeout=True, error=True)
        self.assertIsInstance(result, DeviceDisconnectedError)
        self.assertIn('No active UI root', str(result))
        self.assertGreaterEqual(elapsed, 5)
        self.assertLess(elapsed, 5.2)
        process.kill.assert_not_called()

    def test_other_observation_failures_are_not_retried_as_window_readiness(self):
        result, process, elapsed = self.read([dict(kind='error', stage='tree', detail='permission denied', elapsed_ms=16)], error=True)
        self.assertIn('permission denied', str(result))
        self.assertEqual(elapsed, 0)
        process.stdin.write.assert_called_once_with(b'tree\n')

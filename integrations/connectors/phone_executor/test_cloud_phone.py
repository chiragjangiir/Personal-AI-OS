"""Background lifecycle tools retain the device lease until cleanup completes."""
import asyncio
import fcntl
import json
import threading
import unittest
from pathlib import Path
from unittest import mock
import test_errand_safety as fixtures


class CloudLifecycle(unittest.IsolatedAsyncioTestCase):

    def setUp(self):
        fixtures.CloudExecutor.setUp(self)
        self.provider.status = mock.Mock(return_value={'stage': 'idle', 'elapsed_s': 0})
        self.provider.APP_PACKAGES = tuple(self.s.APPS[app] for app in ('千问', '淘宝', '支付宝', '米家'))
        self.provider.sync_data = mock.Mock()
        self.provider.progress = mock.Mock()
        self.provider.reap_login = mock.Mock(return_value=True)
        patch = mock.patch.object(self.s, 'SPOOL', self.dir.name)
        patch.start()
        self.addCleanup(patch.stop)

    async def asyncTearDown(self):
        if self.s._login_phone is not None:
            self.provider.release.side_effect = None
            await self.s._close_login()
        for job in list(self.s._jobs.values()):
            if not job['task'].done():
                job['task'].cancel()
                await asyncio.gather(job['task'], return_exceptions=True)

    async def finish(self, response):
        jid = response['job_id']
        await self.s._jobs[jid]['task']
        return json.loads((Path(self.dir.name) / f'{jid}.done.json').read_text())

    async def open(self):
        return await self.finish(await self.s.phone_start(principal_id='owner'))

    def assert_locked(self, contender):
        with self.assertRaises(BlockingIOError):
            fcntl.flock(contender, fcntl.LOCK_EX | fcntl.LOCK_NB)

    async def test_failed_start_retries_cleanup_before_releasing_lease(self):
        entered, finish = threading.Event(), threading.Event()
        self.addCleanup(finish.set)
        calls = 0
        def reap(*, force):
            self.assertTrue(force)
            nonlocal calls
            calls += 1
            if calls == 1:
                raise RuntimeError('delete unavailable')
            entered.set()
            if not finish.wait(2):
                raise RuntimeError('fake SDK gate timed out')
            return True
        self.provider.reap_login.side_effect = reap
        self.provider.lease.side_effect = RuntimeError('lease failed')
        with mock.patch.object(self.s, 'LOGIN_RETRY_S', 0.01):
            done = await self.open()
            self.assertFalse(done['success'])
            self.assertEqual(done['terminal_reason'], 'failed')
            self.assertEqual(done['tier'], 'lifecycle')
            self.assertFalse(done['retryable'])
            self.assertTrue(await asyncio.to_thread(entered.wait, 1))
            with self.lock.open() as contender:
                self.assert_locked(contender)
                finish.set()
                for _ in range(100):
                    if self.s._login_lease is None:
                        break
                    await asyncio.sleep(0.01)
                self.assertIsNone(self.s._login_lease)
                fcntl.flock(contender, fcntl.LOCK_EX | fcntl.LOCK_NB)
        self.assertEqual(calls, 2)

    async def test_start_returns_before_create_and_status_never_waits_for_sdk(self):
        entered, finish = asyncio.Event(), asyncio.Event()
        async def lease(purpose):
            entered.set()
            await finish.wait()
            return self.phone
        self.provider.lease.side_effect = lease
        self.provider.status.return_value = {'stage': 'creating', 'elapsed_s': 2}
        started = await self.s.phone_start(principal_id='owner')
        await asyncio.wait_for(entered.wait(), 1)
        status = await asyncio.wait_for(self.s.phone_status(principal_id='owner'), 1)
        self.assertEqual((status['stage'], status['jobs'][0]['job_id']), ('creating', started['job_id']))
        self.assertEqual((await self.s.phone_start(principal_id='owner'))['status'], 'busy')
        finish.set()
        self.assertTrue((await self.finish(started))['success'])
        self.provider.lease.assert_awaited_once_with('login')
        self.provider.status.return_value = {'stage': 'ready', 'view_url': 'https://fresh'}
        self.assertEqual((await self.s.phone_control_link(principal_id='owner'))['view_url'], 'https://fresh')
        with self.lock.open() as contender:
            self.assert_locked(contender)
        refused = await self.s.phone_task('读取首页', principal_id='owner', effect={
            'kind': 'read', 'task_type': 'read_app', 'requested': True})
        self.assertFalse(refused['success'])
        self.provider.session_exists.assert_not_called()

    async def test_bound_lifecycle_job_keeps_the_request_lineage(self):
        started = await self.s.phone_start(principal_id='owner', job_id='job-0123456789ab',
                                           origin_processed_event_id='origin-1')
        self.assertEqual(started['job_id'], 'job-0123456789ab')
        done = await self.finish(started)
        self.assertEqual((done['job_id'], done['origin_processed_event_id']), ('job-0123456789ab', 'origin-1'))

    async def test_selected_restore_save_and_close_have_explicit_effects(self):
        await self.open()
        entered, finish = threading.Event(), threading.Event()
        self.addCleanup(finish.set)
        def sync(*args):
            entered.set()
            if not finish.wait(2):
                raise RuntimeError('fake SDK gate timed out')
        self.provider.sync_data.side_effect = sync
        started = await self.s.phone_restore_apps(['淘宝'], principal_id='owner')
        self.assertTrue(await asyncio.to_thread(entered.wait, 1))
        await asyncio.wait_for(self.s.phone_status(principal_id='owner'), 1)
        self.assertEqual((await self.s.phone_save_apps(['淘宝'], principal_id='owner'))['status'], 'busy')
        finish.set()
        self.assertTrue((await self.finish(started))['success'])
        self.provider.sync_data.assert_called_once_with(self.phone, (self.s.APPS['淘宝'],), 'download')
        self.provider.sync_data.reset_mock()
        self.provider.sync_data.side_effect = None
        self.assertTrue((await self.finish(await self.s.phone_save_apps(['淘宝'], principal_id='owner')))['success'])
        self.provider.sync_data.assert_called_once_with(self.phone, (self.s.APPS['淘宝'],), 'upload')
        self.provider.sync_data.reset_mock()
        self.assertTrue((await self.finish(await self.s.phone_close(principal_id='owner')))['success'])
        self.provider.sync_data.assert_not_called()
        self.provider.release.assert_awaited_once_with(self.phone, keep_warm=False, sync=False)

    async def test_close_holds_lease_through_delete_and_retries_failure(self):
        await self.open()
        entered, finish = asyncio.Event(), asyncio.Event()
        async def release(*args, **kwargs):
            entered.set()
            await finish.wait()
            raise RuntimeError('delete unavailable')
        self.provider.release.side_effect = release
        with mock.patch.object(self.s, 'LOGIN_RETRY_S', 0.01):
            started = await self.s.phone_close(principal_id='owner')
            await asyncio.wait_for(entered.wait(), 1)
            await asyncio.wait_for(self.s.phone_status(principal_id='owner'), 1)
            with self.lock.open() as contender:
                self.assert_locked(contender)
                finish.set()
                self.assertFalse((await self.finish(started))['success'])
                self.assert_locked(contender)
                self.provider.release.side_effect = None
                await asyncio.wait_for(self.phone._expiry, 1)
                fcntl.flock(contender, fcntl.LOCK_EX | fcntl.LOCK_NB)
        self.assertIsNone(self.s._login_phone)

    async def test_expiry_retries_failure_and_holds_lease_until_deleted(self):
        failed = asyncio.Event()
        async def release(*args, **kwargs):
            if not failed.is_set():
                failed.set()
                raise RuntimeError('delete unavailable')
        self.provider.release.side_effect = release
        with mock.patch.object(self.s, 'LOGIN_MAX_S', 0.01), mock.patch.object(self.s, 'LOGIN_RETRY_S', 0.01):
            await self.open()
            expiry = self.phone._expiry
            await asyncio.wait_for(failed.wait(), 1)
            with self.lock.open() as contender:
                self.assert_locked(contender)
                await asyncio.wait_for(expiry, 1)
                fcntl.flock(contender, fcntl.LOCK_EX | fcntl.LOCK_NB)
        self.assertEqual(self.provider.release.await_count, 2)

    async def test_cancelled_restore_joins_sdk_before_next_operation(self):
        await self.open()
        entered, finish = threading.Event(), threading.Event()
        self.addCleanup(finish.set)
        def sync(*args):
            entered.set()
            if not finish.wait(2):
                raise RuntimeError('fake SDK gate timed out')
        self.provider.sync_data.side_effect = sync
        started = await self.s.phone_restore_apps(['淘宝'], principal_id='owner')
        self.assertTrue(await asyncio.to_thread(entered.wait, 1))
        task = self.s._jobs[started['job_id']]['task']
        await asyncio.wait_for(self.s.phone_cancel(started['job_id']), 1)
        await asyncio.sleep(0)
        self.assertFalse(task.done())
        self.assertTrue(self.s._one_phone.locked())
        self.assertEqual((await self.s.phone_close(principal_id='owner'))['status'], 'busy')
        with self.lock.open() as contender:
            self.assert_locked(contender)
        finish.set()
        await asyncio.wait_for(task, 1)
        done = json.loads((Path(self.dir.name) / f"{started['job_id']}.done.json").read_text())
        self.assertEqual(done['terminal_reason'], 'cancelled_by_user')
        self.assertTrue((await self.finish(await self.s.phone_close(principal_id='owner')))['success'])

    async def test_cloud_wechat_restore_and_save_are_rejected_before_dispatch(self):
        await self.open()
        for operation in (self.s.phone_restore_apps, self.s.phone_save_apps):
            with self.assertRaisesRegex(ValueError, '云手机禁止微信'):
                await operation(['微信'], principal_id='owner')
        self.provider.sync_data.assert_not_called()
        self.assertFalse(self.s._jobs)

"""A stop during a blocking phone step (unlock) must not let the step keep typing after "stopped" is reported."""
import asyncio
import sys
import threading
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import server  # noqa: E402


class TypingStep(unittest.TestCase):
    def test_a_stop_mid_unlock_types_nothing_more_and_is_reported_only_after_the_thread_ended(self):
        inputs, ended = [], threading.Event()

        def unlock(stop):
            try:
                for key in ("wake", "swipe", "pin", "enter"):
                    if stop.is_set():
                        raise server._Stopped()
                    inputs.append(key)
                    time.sleep(0.2)
            finally:
                ended.set()

        async def run():
            task = asyncio.ensure_future(server._typing_step(unlock))
            await asyncio.sleep(0.3)  # mid-unlock
            task.cancel()
            await asyncio.sleep(0.02)
            task.cancel()  # another stop while the worker is still returning
            with self.assertRaises(asyncio.CancelledError):
                await task
            self.assertTrue(ended.is_set(), "the thread had returned before the stop was reported")
            typed = list(inputs)
            await asyncio.sleep(0.5)
            self.assertEqual(inputs, typed, "nothing typed after the stop")
            self.assertLess(len(inputs), 4, "the unlock did not run to completion")

        asyncio.run(run())

    def test_without_a_stop_the_step_returns_its_value(self):
        self.assertEqual(asyncio.run(server._typing_step(lambda stop: "unlocked")), "unlocked")


if __name__ == "__main__":
    unittest.main()

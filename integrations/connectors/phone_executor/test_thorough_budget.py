"""Exercise the deployed profile through Mobilerun and the streaming OpenAI SDK, offline."""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import httpx
from llama_index.core.base.llms.types import ChatMessage
from mobilerun.agent.utils.inference import acall_with_retries
from mobilerun.agent.utils.llm_picker import load_llms_from_profiles
from mobilerun.config_manager import ConfigLoader

sys.path.insert(0, str(Path(__file__).resolve().parent))
import server  # noqa: E402


class ThoroughBudget(unittest.IsolatedAsyncioTestCase):
    async def test_thorough_budget_reaches_streamed_request_body(self):
        requests = []
        model = "zai-org/GLM-5.3-Flash"

        def endpoint(request):
            requests.append(json.loads(request.content))
            events = []
            for delta, finish in (
                ({"role": "assistant", "content": ""}, None),
                ({"reasoning_content": "Read the visible cards."}, None),
                ({"content": "Swipe up."}, None),
                ({}, "stop"),
            ):
                chunk = {"id": "offline", "object": "chat.completion.chunk", "created": 0,
                         "model": model, "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}
                events.append("data: " + json.dumps(chunk) + "\n\n")
            return httpx.Response(200, headers={"content-type": "text/event-stream"},
                                  text="".join(events) + "data: [DONE]\n\n")

        transport = httpx.MockTransport(endpoint)
        with tempfile.TemporaryDirectory() as tmp, httpx.Client(transport=transport) as sync_client:
            key_file = Path(tmp, "test-key")
            key_file.write_text("offline-test-key")
            async with httpx.AsyncClient(transport=transport) as async_client:
                with mock.patch.dict(os.environ, {"PAIOS_SILICONFLOW_KEY_FILE": str(key_file)}), \
                     mock.patch.object(server, "_ipv4_clients", return_value={
                         "http_client": sync_client, "async_http_client": async_client}):
                    # Same config loading, tier selection and binding as server._agent.
                    config = ConfigLoader.load(str(Path(__file__).with_name("mobilerun-config.example.yaml")))
                    server._thorough(config)
                    server._bind(config)
                    llm = load_llms_from_profiles(config.llm_profiles, profile_names=["fast_agent"])["fast_agent"]
                    response = await acall_with_retries(llm, [ChatMessage(role="user", content="Read the cards.")],
                                                       stream=config.agent.streaming)

        self.assertEqual(response.message.content, "Swipe up.")
        self.assertEqual(len(requests), 1)
        self.assertEqual(requests[0]["model"], model)
        self.assertIs(requests[0]["stream"], True)
        self.assertEqual(requests[0].get("thinking_budget"), 1024)


if __name__ == "__main__":
    unittest.main()

"""Deterministic OpenAI protocol fixture; it does not establish model semantics."""
import argparse
import json
from pathlib import Path
from aiohttp import web

_SKILL = (Path(__file__).parents[2] / "integrations/hermes/personal_aios/skills/personal-aios-main/SKILL.md").read_text()
_REQUESTS = []


async def complete(request):
    body = await request.json()
    messages = body.get("messages", [])
    _REQUESTS.append({"full_skill_included": any(_SKILL.strip() in str(m.get("content", "")) for m in messages),
                      "message_count": len(messages), "tool_names": [t["function"]["name"] for t in body.get("tools", [])]})
    last_user = next((m.get("content", "") for m in reversed(messages) if m["role"] == "user"), "")
    silent = '"fixture_reply_mode":"none"' in str(last_user).replace(" ", "")
    silent = silent or "fixture_reply_none" in str(last_user)
    candidate = "fixture_memory_candidate" in str(last_user)
    voice = "fixture_voice" in str(last_user)
    read_first = "fixture_read_l5" in str(last_user) or candidate
    # Every logical run has a new user message, even when the transcript has older tools.
    since_user = messages[max(i for i, m in enumerate(messages) if m["role"] == "user") + 1:]
    tool_count = sum(m["role"] == "tool" for m in since_user)
    tool_done = tool_count >= (3 if candidate else 2 if read_first else 1)
    if tool_done:
        text = "" if silent else "确定性桩回复：已收到本轮 ProcessedEvent。"
        message = {"role": "assistant", "content": text or "等待后续输入。"}
        reason = "stop"
    else:
        mode = "none" if silent else "voice" if voice else "text"
        receipts = [json.loads(m["content"]) for m in since_user if m["role"] == "tool"]
        committed = [r["receipt_ref"] for r in receipts if isinstance(r, dict) and r.get("status") == "committed"]
        args = {"reply_mode": mode, "target_aliases": ["source"],
                "output_modes": [] if silent else [mode], "receipt_refs": committed, "evidence_refs": []}
        tool = ("paios_l5_read" if read_first and tool_count == 0 else
                "paios_l3_commit" if candidate and tool_count == 1 else "paios_open_reply")
        if tool == "paios_l5_read":
            d = json.loads(last_user)
            args = {"raw_ref": d["raw_ref"], "archive_revision": d["archive_revision"]}
        if tool == "paios_l3_commit":
            d = json.loads(last_user)
            evidence = {k: d[k] for k in ("event_id", "processed_event_id", "raw_ref", "archive_revision", "time_range")}
            args = {"command_id": "fixture-command:" + d["processed_event_id"], "operation": "create",
                "expected_version": 0, "evidence_refs": [evidence], "assertion": {
                    "assertion_id": "fixture-assertion:" + d["processed_event_id"], "kind": "inference",
                    "subject_ref": {"type": "known_person", "id": d["principal_id"]},
                    "predicate": "isolated_protocol_candidate", "value": "test-only",
                    "scope": {"principal_id": d["principal_id"], "purpose": "protocol_fixture",
                              "situation": "isolated", "role": "test", "evaluation_frame": "unconfirmed"},
                    "evidence_refs": [evidence], "evidence_status": "fixture_unconfirmed",
                    "unknown_conditions": ["model semantics unverified"], "conflicts": [],
                    "status": "candidate", "applicability_status": "applicable", "relation_to_peers": "unknown",
                    "typed_scores": {}, "depends_on": []}}
        message = {"role": "assistant", "content": "内部工作说明，不应发送到终端。", "tool_calls": [{
            "id": "fixture_read_1" if tool == "paios_l5_read" else "fixture_commit_1" if tool == "paios_l3_commit" else "fixture_open_1", "type": "function", "function": {
                "name": tool, "arguments": json.dumps(args)}}]}
        reason = "tool_calls"
    usage = {"prompt_tokens": 100, "completion_tokens": 20, "total_tokens": 120}
    if not body.get("stream"):
        return web.json_response({"id": "fixture_completion", "object": "chat.completion", "model": "paios-fixture",
            "choices": [{"index": 0, "message": message, "finish_reason": reason}], "usage": usage})
    response = web.StreamResponse(headers={"Content-Type": "text/event-stream"})
    await response.prepare(request)
    delta = dict(message)
    if "tool_calls" in delta:
        delta["tool_calls"][0]["index"] = 0
    for content in ({"choices": [{"index": 0, "delta": delta, "finish_reason": None}]},
                    {"choices": [{"index": 0, "delta": {}, "finish_reason": reason}], "usage": usage}):
        await response.write(("data: " + json.dumps({"id": "fixture_completion", "object": "chat.completion.chunk",
            "model": "paios-fixture", **content}) + "\n\n").encode())
    await response.write(b"data: [DONE]\n\n")
    return response


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=18643)
    args = parser.parse_args()
    app = web.Application()
    app.router.add_post("/v1/chat/completions", complete)
    app.router.add_get("/v1/models", lambda request: web.json_response({"data": [{"id": "paios-fixture"}]}))
    app.router.add_get("/fixture/metrics", lambda request: web.json_response({"requests": _REQUESTS}))
    web.run_app(app, host="127.0.0.1", port=args.port)

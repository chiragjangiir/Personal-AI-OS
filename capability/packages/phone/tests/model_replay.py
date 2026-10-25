"""Narration-only configured-brain replay. No tools, owner accounts, TTS or vision calls."""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile


def run(args):
    destination = Path(args.output)
    destination.parent.mkdir(parents=True, exist_ok=True)
    root = Path(__file__).resolve().parents[4]
    samples = json.loads(Path(args.input).read_text())
    gateway = subprocess.check_output(["ip", "route", "show", "default"], text=True).split()[2]
    # This process is the test client. Host networking and the runner's environment are unchanged.
    os.environ["HTTPS_PROXY"] = f"http://{gateway}:7897"
    os.environ["HTTP_PROXY"] = os.environ["HTTPS_PROXY"]
    with tempfile.TemporaryDirectory(prefix="phone-brain-", dir=root / ".scratch/tmp") as tmp:
        key = Path(tmp) / "model.key"
        shutil.copyfile(args.key_file, key)
        key.chmod(0o600)
        os.environ["HERMES_HOME"] = str(Path(tmp) / "hermes")
        from run_agent import AIAgent
        agent = AIAgent(api_key=key.read_text().strip(), base_url=args.base_url, model=args.model,
            provider="openai", api_mode="chat_completions", enabled_toolsets=[], disabled_toolsets=["all"],
            ephemeral_system_prompt="根据已有的结构化回执回复主人，只陈述有来源的事实。",
            skip_context_files=True, skip_memory=True, skip_background_review=True,
            save_trajectories=False, quiet_mode=True, max_iterations=1,
            session_id="phone-receipt-replay", platform="api_server")
        try:
            for sample in samples:
                if sample.get("model_replayed"):
                    continue
                messages = [{"role": "system", "content": agent._build_system_prompt()},
                    {"role": "user", "content": sample["owner_input"]},
                    {"role": "system", "content": json.dumps({"receipts": sample["receipts"]}, ensure_ascii=False)}]
                kwargs = agent._build_api_kwargs(messages, tools_for_api=[])
                kwargs.pop("tools", None)
                kwargs.pop("tool_choice", None)
                for attempt in range(2):
                    try:
                        response = agent._interruptible_api_call(kwargs)
                        break
                    except (ConnectionError, TimeoutError):
                        if attempt:
                            raise
                sample["text"] = response.choices[0].message.content or ""
                sample["model_replayed"] = True
                sample["model"] = args.model
                sample["provider"] = "Open Design Go"
                sample["usage"] = response.usage.model_dump() if response.usage else None
                destination.write_text(json.dumps(samples, ensure_ascii=False, indent=2) + "\n")
                print(json.dumps({"id": sample["id"], "completed": True}), flush=True)
        finally:
            agent.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("input")
    parser.add_argument("output")
    parser.add_argument("--key-file", required=True)
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--model", required=True)
    run(parser.parse_args())

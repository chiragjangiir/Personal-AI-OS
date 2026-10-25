"""Opt-in isolated model replays through the native brain; no production credentials."""
import json
import os
from pathlib import Path
import subprocess


def configure(home, key_file, extra=None):
    import yaml
    home = Path(home)
    home.mkdir(parents=True, exist_ok=True)
    # Client-process proxy only. This never changes the distro or host network configuration.
    gateway = subprocess.check_output(["ip", "route", "show", "default"], text=True).split()[2]
    proxy = "http://" + gateway + ":7897"
    os.environ.update(HERMES_HOME=str(home), HERMES_ENABLE_PROJECT_PLUGINS="0", HERMES_SYNC_ENABLED="false",
                      HTTP_PROXY=proxy, HTTPS_PROXY=proxy, ALL_PROXY=proxy,
                      http_proxy=proxy, https_proxy=proxy, all_proxy=proxy,
                      NO_PROXY="127.0.0.1,localhost,::1", no_proxy="127.0.0.1,localhost,::1")
    config = {"model": {"default": "deepseek-v4.1-flash", "provider": "capability-test",
                        "base_url": "https://amr-link.open-design.ai/v1"},
              "custom_providers": [{"name": "capability-test", "base_url": "https://amr-link.open-design.ai/v1",
                                    "key_env": "PAIOS_CAPABILITY_TEST_KEY", "api_mode": "chat_completions"}],
              "memory": {"memory_enabled": False, "user_profile_enabled": False},
              "compression": {"enabled": False}, "agent": {"max_tool_calls": 12, "api_max_retries": 0, "auto_recovery_cycles": 0},
              "tools": {"tool_search": {"enabled": "off"}},
              "delegation": {"model": "deepseek-v4.1-flash", "provider": "capability-test",
                             "base_url": "https://amr-link.open-design.ai/v1", "max_concurrent_children": 1,
                             "max_spawn_depth": 2, "child_timeout_seconds": 120}}
    config.update(extra or {})
    (home / "config.yaml").write_text(yaml.safe_dump(config, allow_unicode=True))
    os.environ["PAIOS_CAPABILITY_TEST_KEY"] = Path(key_file).read_text().strip()
    return config


def brain(config, *, tools=(), session="capability-replay", max_tokens=8192):
    from run_agent import AIAgent
    return AIAgent(model=config["model"]["default"], provider=config["model"]["provider"],
        base_url=config["model"]["base_url"], api_key=os.environ["PAIOS_CAPABILITY_TEST_KEY"],
        api_mode="chat_completions", enabled_toolsets=list(tools), session_id=session, platform="api_server",
        max_iterations=12, max_tokens=max_tokens, context_length=131072,
        skip_memory=True, skip_context_files=True, skip_background_review=True, quiet_mode=True,
        save_trajectories=False, reasoning_config={"enabled": False})


def model_text(config, prompt, system):
    # One retry for a transport failure, with a fresh turn and the same recorded evidence.
    from openai import APIConnectionError, APITimeoutError
    for attempt in range(2):
        agent = brain(config)
        try:
            result = agent.run_conversation(prompt, system_message=system)
            if result.get("failed") or result.get("error"):
                raise RuntimeError("native_model_turn_failed")
            return result
        except (APIConnectionError, APITimeoutError):
            if attempt:
                raise
        finally:
            agent.close()

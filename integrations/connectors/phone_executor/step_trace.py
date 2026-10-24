"""Bounded observations of Mobilerun events and LlamaIndex model-call lifetimes."""
import contextvars
import re
import time
from datetime import datetime, timezone

current = contextvars.ContextVar("phone_step_trace", default=None)
_installed = False


def _now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class StepTrace:
    def __init__(self, changed=lambda force=False: None):
        self.steps, self.in_progress, self.truncated_steps = [], None, 0
        self.index, self.model_since, self.model_spans = 0, None, set()
        self.changed, self.frozen = changed, None
        self.ledger, self.last_screen_text = "", ""
        self.ledger_truncated = self.screen_truncated = False

    def start(self):
        if self.frozen is not None or self.in_progress is not None:
            return
        self.index += 1
        self.since = time.monotonic()
        self.in_progress = dict(index=self.index, started_at=_now(), ended_at=None,
                                elapsed_seconds=0, model_wait_seconds=0, action="observe",
                                target="", tool_result_status="pending", waiting_for="device", status="running")

    def model(self, event):
        if self.frozen is not None:
            return
        name, span = type(event).__name__, event.span_id
        if name in ("LLMChatStartEvent", "LLMCompletionStartEvent"):
            self.start()
            if not self.model_spans:
                self.model_since = time.monotonic()
            self.model_spans.add(span)
            self.in_progress["waiting_for"] = "model"
        elif span in self.model_spans:
            self.model_spans.remove(span)
            if not self.model_spans:
                self.in_progress["model_wait_seconds"] += time.monotonic() - self.model_since
                self.model_since = None
                self.in_progress["waiting_for"] = "device"
        self.changed(True)

    def finish(self, status):
        if self.in_progress is None or self.frozen is not None:
            return
        step = self.snapshot()["in_progress"]
        step.update(ended_at=_now(), status="finished", waiting_for=None, tool_result_status=status)
        self.steps.append(step)
        if len(self.steps) > 32:
            self.steps.pop(0)
            self.truncated_steps += 1
        self.in_progress = None

    def event(self, ev):
        if self.frozen is not None:
            return
        name = type(ev).__name__
        if name in ("FastAgentInputEvent", "ManagerContextEvent", "ExecutorContextEvent"):
            if self.in_progress and self.in_progress["action"] == "decide":
                self.finish("no_action")
            self.start()
        elif name == "FastAgentResponseEvent":
            from mobilerun.agent.fast_agent.xml_parser import extract_add_memory
            self.start()
            self.in_progress["action"] = "decide"
            rows = re.findall(r"^\[(?:pending|attempted|changed_unverified|claimed_verified|blocked)\] .+$",
                              extract_add_memory(ev.thought), re.M)
            if rows:
                ledger = "\n".join(rows[:32])
                self.ledger, self.ledger_truncated = ledger[:6000], len(rows) > 32 or len(ledger) > 6000
        elif name == "RecordUIStateEvent":
            self.start()
            self.in_progress["screen_text"] = repr(ev.ui_state[:5])[:300]
            texts = []
            def collect(nodes):
                for node in nodes:
                    texts.extend(node[key] for key in ("text", "contentDescription") if node.get(key))
                    collect(node.get("children") or [])
            collect(ev.ui_state)
            text = "\n".join(dict.fromkeys(texts))
            self.last_screen_text, self.screen_truncated = text[:4000], len(text) > 4000
        elif name in ("FastAgentToolCallEvent", "ExecutorActionEvent"):
            self.start()
            action = ev.tool_calls_repr if name == "FastAgentToolCallEvent" else ev.action_json
            names = re.findall(r'<invoke name="([^"]+)"|"action"\s*:\s*"([^"]+)"', action)
            self.in_progress.update(action=",".join(a or b for a, b in names)[:80] or "tool_call",
                                    waiting_for="app", target=action[:160])
        elif name in ("FastAgentOutputEvent", "ExecutorActionResultEvent", "FastAgentEndEvent"):
            self.start()
            if name == "FastAgentOutputEvent":
                self.in_progress["tool_result_summary"] = ev.output[:300]
                status = "failed" if "<error>" in ev.output else "succeeded"
            else:
                status = "succeeded" if ev.success else "failed"
            self.finish(status)
        elif name == "ManagerPlanEvent":
            self.start()
            self.in_progress.update(action="plan", target=ev.current_subgoal[:160])
            self.finish("succeeded")
        self.changed(name in ("FastAgentInputEvent", "ManagerContextEvent", "ExecutorContextEvent", "FastAgentToolCallEvent",
                              "ExecutorActionEvent", "FastAgentOutputEvent", "ExecutorActionResultEvent", "FastAgentEndEvent", "ManagerPlanEvent"))

    def snapshot(self, stalled=False):
        step = dict(self.in_progress) if self.in_progress else None
        if step:
            now = self.frozen if self.frozen is not None else time.monotonic()
            step["elapsed_seconds"] = round(now - self.since, 3)
            step["model_wait_seconds"] = round(step["model_wait_seconds"] +
                (now - self.model_since if self.model_since is not None else 0), 3)
            if stalled or self.frozen is not None:
                step["status"] = "stalled"
        result = dict(steps=list(self.steps), in_progress=step, truncated_steps=self.truncated_steps)
        if self.ledger or self.last_screen_text:
            rows = re.findall(r"^\[([^]]+)\] (.+)$", self.ledger, re.M)
            result["findings"] = dict(verified=[text for status, text in rows if status == "claimed_verified"],
                not_verified=[f"[{status}] {text}" for status, text in rows if status != "claimed_verified"],
                last_screen_text=self.last_screen_text, truncated=self.ledger_truncated or self.screen_truncated)
        return result

    def stall(self):
        if self.frozen is None:
            self.frozen = time.monotonic()


def bind(trace):
    """Instrumentation reads the current job context; it never stores prompts or model responses."""
    global _installed
    if not _installed:
        from llama_index.core.instrumentation import get_dispatcher
        from llama_index.core.instrumentation.event_handlers import BaseEventHandler
        class ModelWait(BaseEventHandler):
            def handle(self, event, **kwargs):
                trace = current.get()
                if trace is not None and type(event).__name__ in (
                    "LLMChatStartEvent", "LLMChatEndEvent", "LLMCompletionStartEvent", "LLMCompletionEndEvent", "ExceptionEvent"
                ):
                    trace.model(event)
        get_dispatcher().add_event_handler(ModelWait())
        _installed = True
    current.set(trace)


def snapshot(job, *, terminal=False):
    if trace := job.get("_trace"):
        if terminal:
            trace.stall()
        return {"trace": trace.snapshot()}
    if "trace" in job:
        result = {**job["trace"]}
        if terminal and result.get("in_progress"):
            result["in_progress"] = {**result["in_progress"], "status": "stalled"}
        return {"trace": result}
    return {}


def partial_result(record):
    """Project the last durable observations into a failed result without promoting unverified work."""
    findings = record.get("trace", {}).get("findings")
    if record.get("success") or not findings:
        return record
    sections = ["【部分结果；任务未完成】", "已核实（执行代理的读取声明）：",
                *(findings["verified"] or ["无已核实条目。"])]
    sections += ["未核实／未完成：", *(findings["not_verified"] or ["其他任务要求未确认完成。"])]
    if findings["last_screen_text"]:
        sections += ["最后屏幕文字（仅观察，未逐项核实）：", findings["last_screen_text"]]
    if findings["truncated"]:
        sections.append("观察记录已截断，以上不是完整结果。")
    return {**record, "partial_findings": findings, "answer": (record["answer"] + "\n" + "\n".join(sections))[:8000]}

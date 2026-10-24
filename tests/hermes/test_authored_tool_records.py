"""Stored model-authored task content is not a verified diagnostic."""
import copy
import json
from types import SimpleNamespace

from gateway.platforms.api_run_reporting import completion_input, request_report_facts


def messages(receipt):
    return [{"role":"assistant","tool_calls":[{"id":"create-a","type":"function",
        "function":{"name":"kanban_create","arguments":json.dumps({"title":"Unverified cause", "body":"Unverified proposed fix"})}}]},
        {"role":"tool","tool_call_id":"create-a","content":json.dumps(receipt)}]


def packet(rows):
    wire=request_report_facts(SimpleNamespace(_paios_principal_id="owner-a",session_id="session-a"),rows)
    return json.loads(wire["content"].split("\n",1)[1]) if wire else {}


def test_producer_receipt_reaches_request_without_copying_authored_content():
    from tools.kanban_tools import create_receipt
    receipt=json.loads(create_receipt(task_id="task-a",status="blocked"))
    rows=messages(receipt);original=copy.deepcopy(rows)
    records=packet(rows)["authored_tool_records"]
    assert records==[{"tool_call_id":"create-a","tool":"kanban_create","task_id":"task-a", "status":"blocked",
        "input_source":"assistant","receipt_scope":"task_record_created_or_reused",
        "content_provenance":{"input_source":"caller","fields":["title","body"],"verification":"not_performed"}}]
    assert "Unverified" not in json.dumps(records)
    assert rows==original


def test_old_and_failed_receipts_do_not_gain_content_provenance():
    for receipt in ({"ok":True,"task_id":"task-a","status":"blocked"},
                    {"ok":False,"error":"write failed"}):
        assert "authored_tool_records" not in packet(messages(receipt))


def test_child_authored_records_keep_scope_in_parent_facts():
    from tools.kanban_tools import create_receipt
    records=packet(messages(json.loads(create_receipt(task_id="task-a",status="blocked"))))["authored_tool_records"]
    from tools.delegate_tool_child_run import _build_result_entry, _SchemaOutcome
    child=_build_result_entry(SimpleNamespace(session_id="child-a"),
        {"completed":True,"final_response":"Unverified proposed fix",
         "messages":messages(json.loads(create_receipt(task_id="task-a",status="blocked")))},
        0,0.1,_SchemaOutcome(None,None,[],0))
    assert child["authored_tool_records"]==records
    text=completion_input([{"delegation_id":"batch-a","results":[child]}],[])
    facts=packet([{"role":"system","content":text}])
    assert facts["completion_records"][0]["authored_tool_records"]==records
    assert "Unverified" not in json.dumps(facts)

"""A selfcheck's source job remains distinct from jobs returned by observation queries."""
import copy
import json
from gateway.platforms.api_run_reporting import completion_input, task_records


def completion(entry):
    return json.loads(completion_input([{'delegation_id':'selfcheck-a','results':[entry]}],[]).split('\n',1)[1])['completion_events'][0]['results'][0]


def test_source_failure_binds_scope_without_promoting_broad_query_results():
    entry={'source_failure':{'evidence_ref':{'job_id':'target-job'}},'task_records':[
        {'tool':'mcp__self__runtime_query','request':{'source':'errands','text':'target-job'},
         'result':{'records':[{'job_id':'target-job'},{'job_id':'unrelated-job'}]}},
        {'tool':'mcp__phone__phone_status','request':{},'result':{'jobs':[{'job_id':'incidental-job'}]}}]}
    original=copy.deepcopy(entry)
    assert completion(entry)['task_scope']=={'job_ids':['target-job'],'prior_report_refs':[]}
    assert entry==original


def test_execution_receipts_identify_created_and_specifically_queried_jobs():
    entry={'task_records':[
        {'tool':'mcp__phone__phone_task','request':{},'result':{'status':'started','job_id':'created-job'}},
        {'tool':'mcp__phone__phone_status','request':{'job_id':'queried-job'},
         'result':{'jobs':[{'job_id':'queried-job'},{'job_id':'unrelated-job'}]}}]}
    assert completion(entry)['task_scope']['job_ids']==['created-job','queried-job']


def test_phone_record_projection_preserves_existing_delivery_contract_without_defaults():
    source={'job_id':'target-job','execution':{'success':True,'terminal_reason':'completed'},
            'delivery':{'scope':'owner_report','status':'not_delivered','report_guard':{'missing_report_requirements':['nonempty_reply_text']}},
            'task_retry_allowed':False}
    old={'job_id':'legacy-job'}
    def tool(name,args,result):
        return [{'role':'assistant','tool_calls':[{'id':'call-a','function':{'name':name,'arguments':json.dumps(args)}}]},
                {'role':'tool','tool_call_id':'call-a','content':json.dumps(result)}]
    for name,args,result,key in [
        ('mcp__phone__phone_status',{'job_id':'target-job'},{'jobs':[source,old]},'jobs'),
        ('mcp__self__runtime_query',{'source':'errands'},{'source':'errands','hermes':{'records':[source,old]}},'records')]:
        projected=task_records(tool(name,args,result))[0]['result'][key]
        assert projected==[source,old]


def test_source_kind_survives_final_request_facts():
    from types import SimpleNamespace
    from gateway.platforms.api_run_reporting import request_report_facts
    source={'kind':'errand_delivery_failed','job_id':'target-job','evidence_ref':{'job_id':'target-job'}}
    wire=request_report_facts(SimpleNamespace(_paios_principal_id='owner-a',session_id='child-a',
        _paios_failure_context=source),[])
    assert json.loads(wire['content'].split('\n',1)[1])['source_failure']==source


def test_report_delta_compares_only_matching_terminal_receipts_with_sealed_source_event():
    from types import SimpleNamespace
    from gateway.platforms.api_run_reporting import request_report_facts
    before={'kind':'errand_result','job_id':'target-job','success':True,'terminal_reason':'completed','answer':'Original answer'}
    reports=[{'job_id':'target-job','status':'sealed','generated':True,'source_event':before}]
    records=[{'tool_call_id':'started','tool':'mcp__phone__phone_task','request':{},
              'result':{'job_id':'target-job','status':'started'}},
             {'tool_call_id':'unchanged','tool':'mcp__phone__phone_status','request':{'job_id':'target-job'},
              'result':{'jobs':[before]}},
             {'tool_call_id':'terminal','tool':'mcp__phone__phone_status','request':{'job_id':'target-job'},
              'result':{'jobs':[{**before,'answer':'Changed answer','trace':{'steps':[]}}]}},
             {'tool_call_id':'query','tool':'mcp__self__runtime_query','request':{'source':'errands'},
              'result':{'records':[{**before,'answer':'Unrelated observation'}]}}]
    events=[{'delegation_id':'batch-a','results':[{'task_index':0,'task_records':records}]}]
    original=copy.deepcopy((events,reports))
    text=completion_input(events,[],reports)
    entry=json.loads(text.split('\n',1)[1])['completion_events'][0]['results'][0]
    delta=entry['task_scope']['report_delta']
    assert delta==[{'job_id':'target-job','prior_report_index':0,'tool_call_id':'unchanged',
        'unchanged_source_fields':['success','terminal_reason','answer'],
        'changed_source_fields':[],'additional_source_fields':[]},
        {'job_id':'target-job','prior_report_index':0,'tool_call_id':'terminal',
        'unchanged_source_fields':['success','terminal_reason'],
        'changed_source_fields':['answer'],'additional_source_fields':['trace']}]
    wire=request_report_facts(SimpleNamespace(_paios_principal_id='owner-a',session_id='parent-a'),
        [{'role':'system','content':text}])
    packet=json.loads(wire['content'].split('\n',1)[1])
    assert packet['completion_records'][0]['task_scope']['report_delta']==delta
    assert (events,reports)==original
    for report in ({**reports[0],'status':'unsealed'},{**reports[0],'generated':False},
                   {key:value for key,value in reports[0].items() if key!='source_event'}):
        scoped=json.loads(completion_input(events,[],[report]).split('\n',1)[1])['completion_events'][0]['results'][0]['task_scope']
        assert 'report_delta' not in scoped


def test_prior_report_lookup_and_task_scope_share_source_job_membership():
    from types import SimpleNamespace
    from gateway.platforms.api_run_delegation import RunDelegation
    requested=[]
    def lookup(context,jobs):
        requested.extend(jobs)
        return [{'job_id':job,'status':'missing'} for job in jobs]
    agent=SimpleNamespace(_paios_principal_id='owner-a',session_id='session-a',_paios_tool_conversation='conversation-a',
        _memory_manager=SimpleNamespace(get_provider=lambda name:SimpleNamespace(errand_report_context=lookup)))
    source={'evidence_ref':{'job_id':'target-job'}}
    entry={'source_failure':source,'task_records':[{'tool':'mcp__self__runtime_query',
        'request':{'source':'errands','text':'target-job'},
        'result':{'records':[{'job_id':f'unrelated-{index}'} for index in range(21)]}}]}
    bridge=RunDelegation(agent,lambda _:None)
    reports=bridge._prior_reports([{'delegation_id':'selfcheck-a','results':[entry]}])
    assert requested==completion(entry)['task_scope']['job_ids']==['target-job']
    assert reports==[{'job_id':'target-job','status':'missing'}]
    requested.clear()
    bridge._prior_reports([{'source':'errand','delegation_id':'errand-job'}])
    assert requested==['errand-job']

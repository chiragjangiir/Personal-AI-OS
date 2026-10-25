"""Exact-H isolated ownership reproduction; run with the H Hermes Python, no mounts/secrets."""
import asyncio, json, os, sys, tempfile, traceback, logging
from pathlib import Path
from importlib.metadata import version
import mcp.client.stdio as sdk_stdio
spawned=[]
transport_events=[]
original_spawn=sdk_stdio._create_platform_compatible_process
async def record_spawn(*args,**kwargs):
    process=await original_spawn(*args,**kwargs)
    spawned.append((process,kwargs.get('args',[])))
    return process
sdk_stdio._create_platform_compatible_process=record_spawn

async def main():
    with tempfile.TemporaryDirectory(prefix='mcp-native-') as tmp:
        os.environ['HERMES_HOME']=tmp
        os.environ['PYTHONDONTWRITEBYTECODE']='1'
        sys.path.insert(0,'/opt/hermes')
        from tools.mcp_tool import MCPServerTask
        from tools import mcp_tool_lifecycle as lifecycle
        original_track = MCPServerTask._track_spawned_children
        original_signal = lifecycle._signal_mcp_process
        def track(owner, pids):
            transport_events.append({'track': owner.name, 'pids': sorted(pids)})
            return original_track(owner, pids)
        def signal(pid, sig, owner, pgid, my_pgid):
            transport_events.append({'signal': int(sig), 'pid': pid, 'owner': owner})
            return original_signal(pid, sig, owner, pgid, my_pgid)
        MCPServerTask._track_spawned_children = track
        lifecycle._signal_mcp_process = signal
        from tools.mcp_tool_handlers import _call_tool_racing_stdio_death, _render_call_tool_result
        server=MCPServerTask('phone')
        config={'command':sys.executable,'args':['-B','/opt/paios/integrations/hermes/personal_aios/staging/fake_phone.py'], 'env':{'PAIOS_FAKE_PHONE_LOG':tmp+'/phone.jsonl','PAIOS_ERRAND_SPOOL':tmp+'/errands','PYTHONDONTWRITEBYTECODE':'1'},'timeout':20,'connect_timeout':15,'tools':{'resources':False,'prompts':False}}
        events=[]
        try:
            mijia=MCPServerTask('mijia')
            bad={**config,'args':['-B','/opt/paios/capability/packages/mijia/fake/server.py']}
            starts=await asyncio.gather(server.start(config),mijia.start(bad),return_exceptions=True)
            events.append({'starts':[str(v) for v in starts], 'phone_pids':list(server._stdio_child_pids),'mijia_pids':list(mijia._stdio_child_pids),'orphans':list(lifecycle._orphan_stdio_pids)})
            await asyncio.sleep(2)
            events.append({'pre_call_child_dead':server._stdio_children_dead(),'orphans':list(lifecycle._orphan_stdio_pids)})
            events.append({'ready':True,'pids':list(server._stdio_child_pids),'tools':[getattr(t,'name',None) for t in server._tools]})
            for tool,args in [('phone_task',{'app':'千问','goal':'synthetic stop before pay','title':'fake errand','principal_id':'synthetic-owner'}),('phone_status',{'principal_id':'synthetic-owner'})]:
                try:
                    r=await asyncio.wait_for(_call_tool_racing_stdio_death(server,'phone',tool,args),20)
                    events.append({'tool':tool,'result':_render_call_tool_result(r,'phone'),'child_dead':server._stdio_children_dead()})
                except Exception as e:
                    events.append({'tool':tool,'error':repr(e),'traceback':traceback.format_exc(),'child_dead':server._stdio_children_dead()})
            await asyncio.sleep(.2)
        except Exception:
            events.append({'error':traceback.format_exc()})
        finally:
            await server.shutdown()
            await mijia.shutdown()
        print(json.dumps({'mcp':version('mcp'),'events':events,'transport_events':transport_events,'children':[{'pid':p.pid,'exit_status':p.returncode,'args':a} for p,a in spawned],'stderr':(Path(tmp)/'logs/mcp-stderr.log').read_text() if (Path(tmp)/'logs/mcp-stderr.log').exists() else None,'fake_log':Path(tmp+'/phone.jsonl').read_text() if Path(tmp+'/phone.jsonl').exists() else None,'terminal_files':[json.loads(p.read_text()) for p in Path(tmp+'/errands').glob('*.done.json')]},ensure_ascii=False,indent=2))
asyncio.run(main())

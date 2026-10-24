// Uses the production resource factory, protocol and WebSocket. No tool is executed.
export function budgetedSocket(Base, budget) {
  return class extends Base {
    constructor(...args) { super(...args); budget.sessions++; this.evalRequests = 0; }
    send(body, ...args) {
      if (JSON.parse(String(body)).type === 'response.create') {
        if (this.evalRequests >= 1 || budget.requests >= budget.limit) {
          this.close();
          throw Error('EVAL_RESPONSE_BUDGET_EXCEEDED');
        }
        this.evalRequests++; budget.requests++;
      }
      return super.send(body, ...args);
    }
  };
}

export async function runCase({createResources, configuration, instructions, tools, sample, timeoutMs = 45000}) {
  let front, timer, settled = false, finish, fail;
  const events = [], text = [], started = performance.now();
  const done = new Promise((resolve, reject) => {
    finish = result => {
      if (settled) return;
      settled = true; clearTimeout(timer); front?.close();
      resolve({...result,text:text.join(''),events,latency_ms:Math.round(performance.now()-started)});
    };
    fail = error => {
      if (settled) return;
      settled = true; clearTimeout(timer); front?.close(); reject(error);
    };
  });
  timer = setTimeout(()=>fail(Error('EVAL_CASE_TIMEOUT')), timeoutMs);
  try {
    const resources = createResources({configuration, onError:fail});
    front = resources.createFront({instructions, tools,
      // First-tool event closes the session synchronously before the production onTool continuation.
      onTool:()=>new Promise(()=>{}),
      onClose:()=>{if(!settled)fail(Error('EVAL_EARLY_CLOSE'));}, onError:fail,
      onEvent:event=>{
        events.push(event.type);
        if (/^response\.(audio_transcript|output_audio_transcript|text|output_text)\.delta$/.test(event.type)) text.push(event.delta);
        if (event.type === 'response.function_call_arguments.done') {
          try { finish({route:event.name,arguments:JSON.parse(event.arguments)}); }
          catch(error) { fail(error); }
        } else if (event.type === 'response.done') {
          if (event.response?.status !== 'completed') fail(Error('EVAL_RESPONSE_NOT_COMPLETED'));
          else if (event.response?.output?.some(item=>item.type==='function_call')) fail(Error('EVAL_TOOL_ARGUMENTS_MISSING'));
          else finish({route:'front_only'});
        } else if (event.type === 'error') fail(Error(`EVAL_PROVIDER_ERROR:${event.error?.code ?? 'unknown'}`));
      }});
    // Transcript input through the real realtime conversation. This does not test microphone/ASR.
    void (async()=>{
      await front.connect();
      if(sample.context)await front.hear(`【通话背景，仅作观察】${sample.context}`);
      await front.hear(sample.input);
      if (!settled) await front.requestReply();
    })().catch(fail);
  } catch(error) { fail(error); }
  return done;
}

export function baselineVariant(instructions, currentCall, baselineCall, tool, description) {
  if (instructions.split(currentCall).length !== 2) throw Error('EVAL_CALL_PROMPT_NOT_UNIQUE');
  if (!description) throw Error('EVAL_BASELINE_DESCRIPTION_MISSING');
  return {instructions:instructions.replace(currentCall,baselineCall),tool:{...tool,description}};
}

export function score(sample, result) {
  const payload = result.route === 'handoff_to_brain' ? result.arguments?.intent : result.arguments?.query;
  const missing = sample.preserve.filter(pattern=>!new RegExp(pattern,'u').test(payload ?? ''));
  const args = result.arguments;
  const valid = result.route === 'handoff_to_brain' ? args &&
    Object.keys(args).sort().join(',') === 'difficulty,intent,thinking' &&
    typeof args.difficulty === 'string' && args.difficulty.trim().length > 0 && args.difficulty.length <= 500 &&
    typeof args.intent === 'string' && args.intent.trim().length > 0 && args.intent.length <= 4000 &&
    ['enabled','disabled'].includes(args.thinking) : true;
  return {route_pass:result.route===sample.expected,contract_pass:Boolean(valid),preservation_pass:missing.length===0,missing};
}

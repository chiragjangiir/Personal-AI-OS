import {readFileSync,writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import type {Receipt} from '../../../sdk/ts/receipt.ts';

export interface Replay {id:string;text:string;receipts:Receipt[];owner_input:string;acknowledged_fact_ids?:string[];source?:string}
interface Fact {id:string;text:string;voice:string}
interface Check {text:string;removed:{sentence:string;reasons:string[]}[];fact_ids:string[]}
export interface CheckerPort {
  receiptFacts(receipts:Receipt[]):Fact[];
  checkReport(text:string,receipts:Receipt[],ownerInput:string,facts:Fact[]):Check;
}
const classes=['completed_as_running','wrong_number','repeated_fact','redo_success','unknown_as_failed','unproven_effect'] as const;
function errors(decision:Check,sample:Replay){
  const found=new Set<string>();
  for(const item of decision.removed){
    if(item.reasons.includes('unsupported_number'))found.add('wrong_number');
    if(item.reasons.includes('already_reported'))found.add('repeated_fact');
    if(item.reasons.includes('retry_forbidden'))found.add('redo_success');
    if(item.reasons.includes('effect_unproven'))found.add('unproven_effect');
    if(item.reasons.includes('status_conflict')){
      if(sample.receipts.some(r=>r.status.state==='succeeded')&&/还在|正在/u.test(item.sentence))found.add('completed_as_running');
      else if(sample.receipts.some(r=>r.status.state==='unknown')&&/失败|没办成|未办成/u.test(item.sentence))found.add('unknown_as_failed');
      else found.add('status_conflict');
    }
  }
  return [...found];
}
/** The scorer calls the P1 checker; it contains neither a renderer nor a replacement checker. */
export function scoreReplays(samples:Replay[],port:CheckerPort){
  const results=samples.map(sample=>{
    const told=new Set(sample.acknowledged_fact_ids??[]);
    const facts=port.receiptFacts(sample.receipts).filter(fact=>!told.has(fact.id));
    const checked=port.checkReport(sample.text,sample.receipts,sample.owner_input,facts);
    const rechecked=port.checkReport(checked.text,sample.receipts,sample.owner_input,facts);
    const after=errors(rechecked,sample),before=errors(checked,sample);
    return {id:sample.id,source:sample.source,before,after,pass:after.length===0,
      text:checked.text,removed:checked.removed,fact_ids:checked.fact_ids};
  });
  const count=results.filter(r=>r.pass).length;
  return {total:results.length,passed:count,clean_percent:results.length?100*count/results.length:0,
    target_percent:95,meets_target:results.length>0&&100*count/results.length>=95,
    error_classes:Object.fromEntries(classes.map(kind=>[kind,{before:results.filter(r=>r.before.includes(kind)).length,
      after:results.filter(r=>r.after.includes(kind)).length}])),results};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const [input,directory,output]=process.argv.slice(2);
  if(!input||!directory||!output)throw new Error('usage: replay.ts samples.json p1-capability-directory output.json');
  const checker=await import(pathToFileURL(resolve(directory,'checker.ts')).href);
  const renderer=await import(pathToFileURL(resolve(directory,'renderer.ts')).href);
  const samples=JSON.parse(readFileSync(input,'utf8')) as Replay[];
  const result=scoreReplays(samples,{checkReport:checker.checkReport,receiptFacts:renderer.receiptFacts});
  const evidence=Object.fromEntries(['checker.ts','renderer.ts'].map(name=>[name,
    createHash('sha256').update(readFileSync(resolve(directory,name))).digest('hex')]));
  writeFileSync(output,JSON.stringify({...result,checker_evidence:evidence},null,2)+'\n');
  console.log(JSON.stringify({total:result.total,passed:result.passed,clean_percent:result.clean_percent,meets_target:result.meets_target}));
}

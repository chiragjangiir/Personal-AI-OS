import {digest} from '../contracts.ts';
import type {Receipt, State} from '../../../../../../capability/sdk/ts/receipt.ts';
import type {Fact, ReceiptRecord} from './ledger.ts';

// Fixed fact-kind templates. Labels and contents come exclusively from the admitted receipt.
export const statusText: Record<State, [string, string]> = {
  succeeded: ['已完成。', '办好了。'], partial: ['部分完成。', '只完成了一部分。'],
  failed: ['未办成。', '这次没办成。'], unknown: ['结果尚未核实。', '结果还不清楚。'],
  running: ['正在执行。', '还在办。'], accepted: ['请求已接收，尚未确认完成。', '已接收，还没确认完成。'],
  waiting: ['正在等待。', '还在等。'], cancelled: ['已取消。', '已取消。'], rejected: ['请求被拦下，未执行。', '已拦下，没有执行。'],
};
const verification = {verified: '已核验', service_ack: '服务已确认', not_verified: '尚未核验', unknown: '核验结果未知'};
export const displayUnit = (unit: string) => ({none: '', celsius: '°C', percent: '%', seconds: '秒', minutes: '分钟'}[unit] ?? unit);
export function activitySentence(receipts:Receipt[],state:State):string {
  const labels=[...new Set(receipts.flatMap(receipt=>receipt.effects.map(effect=>effect.target.replace(/\s+/gu,' ').trim())))];
  const sentence=(labels.length?labels.join('、')+'，':'')+statusText[state][1];
  return [...sentence].length<=48?sentence:statusText[state][1];
}
export function receiptFacts(receipts: Receipt[], origin?: string): Fact[] {
  const facts: Fact[] = [];
  const add = (kind: string, identity: unknown, text: string, voice = text, match: Partial<Fact> = {}) =>
    facts.push({id: digest({kind, identity, origin:origin??null}), kind, text, voice, ...match});
  for (const receipt of receipts) {
    const targets = [...new Set(receipt.effects.map(effect => effect.target))].join('、') ||
      [...new Set(receipt.values.map(value=>value.key.split('的')[0]!))].join('、') || receipt.content.map(content=>content.key).join('、');
    const label = targets ? targets + '：' : '';
    add('status', [targets, receipt.status.state, receipt.status.reason_code??null], label + statusText[receipt.status.state][0],
      (targets ? targets + '，' : '') + statusText[receipt.status.state][1], {labels:targets?[targets]:[],state:receipt.status.state});
    if (receipt.status.progress) {
      const progress = receipt.status.progress;
      add('progress', progress, `已完成 ${progress.done}/${progress.total} ${progress.unit}。`,
        `${progress.total}${progress.unit}中完成了${progress.done}${progress.unit}。`);
    }
    for (const effect of receipt.effects) add('effect', effect,
      `${effect.target}的${effect.action}，${verification[effect.verification]}。`);
    for (const value of receipt.values) {
      const shown = value.value === null ? '未知' : value.value === true ? '是' : value.value === false ? '否' : String(value.value);
      // as_of proves freshness but does not turn an otherwise unchanged fact into a new fact.
      const {as_of: _, ...identity} = value;
      add('value', identity, `${value.key}：${shown}${displayUnit(value.unit)}，来源${value.source}。`,
        `${value.key}是${shown}${displayUnit(value.unit)}。`, {labels:[value.key,value.key.split('的')[0]!],value});
    }
    for (const content of receipt.content) add('content', content, `${content.key}：${content.text}`);
    for (const unknown of receipt.unknowns) add('unknown', unknown, `${unknown.about}尚不清楚：${unknown.why}。`, `${unknown.about}还不清楚，${unknown.why}。`);
    if (receipt.next.waiting_on !== 'none') {
      const detail=receipt.next.waiting_detail || ({owner: '在等你确认。', external: '在等外部结果。', time: '在等约定时间。'}[receipt.next.waiting_on]);
      add('next', receipt.next, /[。！？]$/u.test(detail)?detail:detail+'。');
    }
    if (receipt.next.retry === 'after_check') add('retry', [targets, receipt.next], '需要先核查结果，再决定是否重试。', '先查清结果，再决定要不要重试。');
    if (receipt.next.retry === 'forbidden' && receipt.status.state === 'succeeded' && receipt.effects.length)
      add('retry', [targets, receipt.next], '这件事无需重复执行。', '不用再做一次。');
  }
  return [...new Map(facts.map(fact => [fact.id, fact])).values()];
}
/** Fresh calls are fresh observations/effects. Follow-ups reuse the same recorded call; jobs keep one causal identity. */
export function recordFacts(records:ReceiptRecord[],run:string):Fact[] {
  return records.flatMap(record=>receiptFacts([record.receipt],record.receipt.job?`job:${record.receipt.job.id}`:digest([record.origin_run??run,record.call_id??record.id])));
}
export const renderFacts = (facts: Fact[], outlet: 'text'|'voice') => facts.map(fact => fact[outlet]).join(outlet === 'text' ? '\n' : '');

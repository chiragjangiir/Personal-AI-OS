const words=new Intl.Segmenter('zh',{granularity:'word'});

/** Activity titles are bounded once, at the display producer, without cutting a word. */
export function activityTitle(text:string,limit=48):string {
  const line=text.split(/[\r\n]/u)[0]!.trim();
  if([...line].length<=limit)return line;
  let title='';
  for(const {segment} of words.segment(line)){
    if([...title,...segment].length>=limit)break;
    title+=segment;
  }
  return title.replace(/[\s，,、。.!！?？:：;；-]+$/u,'')+'…';
}

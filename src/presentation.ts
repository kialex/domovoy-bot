export function escapeHtml(value: string): string {
  return value.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
export function kyivDate(timestamp:number) {
  return new Intl.DateTimeFormat('uk-UA',{timeZone:'Europe/Kyiv',day:'numeric',month:'long',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(timestamp*1000));
}
function remaining(until:number,now:number){
  const seconds=Math.max(0,until-now);
  if(!seconds)return 'Час голосування завершився';
  if(seconds>=86400)return `Залишилось: ${Math.ceil(seconds/86400)} дн.`;
  if(seconds>=3600)return `Залишилось: ${Math.ceil(seconds/3600)} год.`;
  return `Залишилось: ${Math.ceil(seconds/60)} хв.`;
}
export function pollCard(id:number,question:string,options:string[],counts:Map<number,number>,closed:boolean,meta:{description?:string;endsAt?:number|null;closedAt?:number|null;now?:number}={}) {
  const description=meta.description?`\n\n${escapeHtml(meta.description)}`:'';
  const total=[...counts.values()].reduce((sum,count)=>sum+count,0);
  const results=options.map((option,index)=>{
    const count=counts.get(index)||0;const percent=total?Math.round(count/total*100):0;
    const segments=10;const filled=Math.round(percent/100*segments);
    const bar=`<code>${'▰'.repeat(filled)}${'▱'.repeat(segments-filled)}</code>`;
    const ending=count%100>=11&&count%100<=14?'голосів':count%10===1?'голос':count%10>=2&&count%10<=4?'голоси':'голосів';
    return `<b>${index+1}. ${escapeHtml(option)}</b>\n${bar}  ${count} ${ending} · <b>${percent}%</b>`;
  }).join('\n\n');
  const compactDate=(timestamp:number)=>new Intl.DateTimeFormat('uk-UA',{timeZone:'Europe/Kyiv',day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(timestamp*1000));
  const date=closed?(meta.closedAt?`\n📅 ${compactDate(meta.closedAt)} · Київ`:''):
    meta.endsAt?`\n⏳ ${remaining(meta.endsAt,meta.now??Math.floor(Date.now()/1000))}\n📅 До ${kyivDate(meta.endsAt)} (Київ)`:'\n⏳ Без строку · завершує адміністратор';
  if(closed){
    const best=Math.max(0,...options.map((_,index)=>counts.get(index)||0));
    const leaders=options.filter((_,index)=>(counts.get(index)||0)===best);
    const outcome=total===0?'Голосів не подано.':leaders.length===1?`Найбільше голосів — «${escapeHtml(leaders[0])}».`:`Однакова кількість голосів: ${leaders.map(v=>`«${escapeHtml(v)}»`).join(', ')}.`;
    return `🏁 <b>Підсумки голосування: ${escapeHtml(question)}</b>${description}\n\n${results}\n\n🏘 Проголосувало приміщень: <b>${total}</b>${date}\n\n<b>${outcome}</b>`;
  }
  return `🗳 <b>Голосування будинку: ${escapeHtml(question)}</b>\n🟢 Відкрите${date}${description}\n\n${results}\n\n🏘 Проголосувало приміщень: <b>${total}</b>\n\n<i>Оберіть відповідь кнопкою нижче.\nОдин голос від приміщення. Змінити відповідь може лише той, хто її подав, до завершення голосування.</i>`;
}

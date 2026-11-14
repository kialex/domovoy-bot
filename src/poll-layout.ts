import { escapeHtml, kyivDate } from './presentation.ts';
export interface PollLayout {
 title:string;description?:string;options:string[];counts:number[];
 votedPremises?:string[];votes?:{optionIndex:number;kind:string;label:string}[];endsAt?:number|null;closedAt?:number|null;closed?:boolean;now?:number;
 reposted?:boolean;
 pollId?:number;previewUrl?:string;previewNote?:string;daysRemaining?:number;
}
export const voteWord=(n:number)=>n%100>=11&&n%100<=14?'голосів':n%10===1?'голос':n%10>=2&&n%10<=4?'голоси':'голосів';
export function richPollCard(data:PollLayout){
 const total=data.counts.reduce((a,b)=>a+b,0);
 const shown=(data.votedPremises||[]).slice(0,6),remaining=Math.max(0,total-shown.length);
 const unitWord=total%100>=11&&total%100<=14?'приміщень':total%10>=1&&total%10<=4?'приміщення':'приміщень';
 const summary=data.closed
  ?`<p>👥 Взяли участь у голосуванні — <b>${total} ${unitWord}</b></p>`
  :`<p>👥 Проголосували <b>${total} ${unitWord}</b>${shown.length?`: ${shown.map(escapeHtml).join(', ')}${remaining?` та ще ${remaining}`:''}`:''}</p>`;
 const options=data.options.map((option,index)=>{
  const count=data.counts[index]||0,percent=total?Math.round(count/total*100):0;
  const row=`<table><tr><td colspan="7" valign="top">${escapeHtml(option)}</td><td valign="top" align="right"><b>${percent}%</b></td></tr></table>`;
  if(data.closed){
   const votes=(data.votes||[]).filter(v=>v.optionIndex===index);
   const labels=votes.map(v=>escapeHtml(v.label));
   return `${row}<p>${count} ${voteWord(count)}</p>${labels.length?`<p>Приміщення: ${labels.join(', ')}</p>`:''}`;
  }
  const action=data.pollId?`type="callback_data" data="vote:${data.pollId}:${index}" style="primary"`:data.previewUrl?`type="url" url="${escapeHtml(data.previewUrl)}" style="primary"`:'type="disabled"';
  return `${row}<tg-button-row><tg-button ${action}>Проголосувати · ${count} ${voteWord(count)}</tg-button></tg-button-row>`;
 }).join('');
 const now=data.now??Math.floor(Date.now()/1000);
 let time='⏳ Без строку';
 if(data.closed)time=data.closedAt?`Завершено: ${kyivDate(data.closedAt)} · Київ`:'Голосування завершено';
 else if(data.endsAt){const seconds=data.endsAt-now;time=seconds<=0?'Час голосування завершився':`⏳ Залишилось: ${seconds>=86400?Math.ceil(seconds/86400)+' дн.':seconds>=3600?Math.ceil(seconds/3600)+' год.':Math.ceil(seconds/60)+' хв.'}`;}
 else if(data.daysRemaining!==undefined)time=`⏳ Залишилось: ${data.daysRemaining} дн.`;
 let outcome='';
 if(data.closed){const best=Math.max(0,...data.counts);const leaders=data.options.filter((_,i)=>(data.counts[i]||0)===best);outcome=total===0?'Голосів не подано.':leaders.length===1?`Найбільше голосів — «${escapeHtml(leaders[0])}».`:`Однакова кількість голосів: ${leaders.map(v=>`«${escapeHtml(v)}»`).join(', ')}.`;}
 const secondsLeft=data.endsAt ? data.endsAt-now : null;
 let reminder='';
 if(data.reposted&&!data.closed&&(secondsLeft===null||secondsLeft>0)){
  const message=secondsLeft!==null&&secondsLeft<=86400
   ? 'Голосування скоро завершиться. Якщо ще не проголосували, встигніть долучитися.'
   : 'Сусіди, якщо ще не встигли проголосувати, долучайтеся. Кожен голос важливий для спільного рішення.';
  reminder=`<p>🔔 ${message}</p>`;
 }
 return {html:`<h2>${data.closed?'Підсумки голосування: ':''}${escapeHtml(data.title)}</h2>${data.closed?'':`<p><b>${time}</b></p>`}${reminder}${summary}<hr/>${!data.closed&&data.description?`<p>${escapeHtml(data.description).replace(/\n/g,'<br/>')}</p>`:''}${options}${data.closed?`<p>${time}</p>`:''}${outcome?`<p><b>${outcome}</b></p>`:''}${data.previewNote?`<footer>${escapeHtml(data.previewNote)}</footer>`:''}`};
}

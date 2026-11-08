import { escapeHtml, kyivDate } from './presentation.ts';
export interface PollLayout {
 title:string;description?:string;options:string[];counts:number[];
 votedPremises?:string[];endsAt?:number|null;closedAt?:number|null;closed?:boolean;now?:number;
 pollId?:number;previewUrl?:string;previewNote?:string;daysRemaining?:number;
}
export const voteWord=(n:number)=>n%100>=11&&n%100<=14?'голосів':n%10===1?'голос':n%10>=2&&n%10<=4?'голоси':'голосів';
export function richPollCard(data:PollLayout){
 const total=data.counts.reduce((a,b)=>a+b,0);
 const shown=(data.votedPremises||[]).slice(0,6),remaining=Math.max(0,total-shown.length);
 const unitWord=total%100>=11&&total%100<=14?'приміщень':total%10>=1&&total%10<=4?'приміщення':'приміщень';
 const summary=`<p>👥 Проголосували <b>${total} ${unitWord}</b>${shown.length?`: ${shown.map(escapeHtml).join(', ')}${remaining?` та ще ${remaining}`:''}`:''}</p>`;
 const options=data.options.map((option,index)=>{
  const count=data.counts[index]||0,percent=total?Math.round(count/total*100):0;
  const row=`<table><tr><td colspan="7" valign="top">${escapeHtml(option)}</td><td valign="top" align="right"><b>${percent}%</b></td></tr></table>`;
  if(data.closed)return `${row}<p>${count} ${voteWord(count)}</p>`;
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
 return {html:`<h2>${data.closed?'Підсумки голосування: ':''}${escapeHtml(data.title)}</h2>${summary}<hr/>${data.description?`<p>${escapeHtml(data.description).replace(/\n/g,'<br/>')}</p>`:''}${options}<p>${time}</p>${outcome?`<p><b>${outcome}</b></p>`:''}${data.previewNote?`<footer>${escapeHtml(data.previewNote)}</footer>`:''}`};
}

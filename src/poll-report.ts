import type { Env, Button } from './env.ts';
import { send, sendHtml } from './telegram.ts';
import { escapeHtml, pollCard } from './presentation.ts';

export async function adminPollReport(env:Env,id:number) {
  const p=await env.HOME_DB.prepare("SELECT * FROM polls WHERE id=? AND status IN ('open','closed')").bind(id).first<{id:number;question:string;options:string;status:string;ends_at:number|null;closed_at:number|null}>();
  if(!p)return send(env,env.ADMIN_TELEGRAM_USER_ID,'Голосування не знайдено.');
  const {results:rows}=await env.HOME_DB.prepare(`SELECT v.option_index,p.kind,p.number,p.business_name,p.entrance FROM premise_votes v JOIN premises p ON p.id=v.premise_id WHERE v.poll_id=? ORDER BY p.entrance,p.number_start,p.number,p.business_name`).bind(id).all<{option_index:number;kind:string;number:string;business_name:string;entrance:number|null}>();
  const options=JSON.parse(p.options) as string[];
  const counts=new Map<number,number>();for(const r of rows)counts.set(r.option_index,(counts.get(r.option_index)||0)+1);
  const blocks=[pollCard(id,p.question,options,counts,p.status==='closed',{endsAt:p.ends_at,closedAt:p.closed_at}),'<b>👥 Приміщення, що проголосували</b>'];
  const groups=[...new Set(rows.filter(r=>r.kind==='apartment').map(r=>r.entrance))].map(entrance=>({title:entrance===null?'Під’їзд не вказано':`Під’їзд ${entrance}`,rows:rows.filter(r=>r.kind==='apartment'&&r.entrance===entrance)}));
  const commerce=rows.filter(r=>r.kind==='commercial');if(commerce.length)groups.push({title:'Комерція',rows:commerce});
  if(!rows.length)blocks.push('Ще ніхто не проголосував.');
  for(const group of groups){
    blocks.push(`<b>${escapeHtml(group.title)}</b>`);
    options.forEach((option,index)=>{
      const units=group.rows.filter(r=>r.option_index===index).map(r=>r.kind==='commercial'?r.business_name||'Комерція':r.number);
      if(!units.length)return;
      let line=`${option}: `;
      for(const unit of units){if((line+unit).length>1200){blocks.push(escapeHtml(line));line=`${option} (продовження): `;}line+=`${line.endsWith(': ')?'':', '}${unit}`;}
      blocks.push(escapeHtml(line));
    });
  }
  const buttons:Button[][]=[];
  if(p.status==='closed')buttons.push([{text:'🗑 Видалити голосування',callback_data:`pollctl:askdelete:${id}`}]);
  buttons.push([{text:'← Мої голосування',callback_data:`pollctl:list:0:${p.status}`}]);
  let message='';
  for(const block of blocks){if(message.length+block.length+2>3800){await sendHtml(env,env.ADMIN_TELEGRAM_USER_ID,message);message='';}message+=(message?'\n\n':'')+block;}
  return sendHtml(env,env.ADMIN_TELEGRAM_USER_ID,message,buttons);
}

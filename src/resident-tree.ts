import type { Button, Env } from './env.ts';
import { getGroup, isConnected } from './groups.ts';
import { escapeHtml, telegramProfileLink } from './presentation.ts';
import { roleLabel, roleIcon } from './premises.ts';
import type { Membership, Premise } from './premises.ts';
import { telegram } from './telegram.ts';

interface TreeUnit extends Premise {member_count:number}
export interface TreeState {chat:number;entrance:string;floor:string;unit:number;page:number}
const ROOT='-';const UNKNOWN='n';const UNITS_PER_PAGE=6;const PEOPLE_PER_PAGE=3;
const clean=(text:string,max=120)=>text.replace(/\s+/g,' ').trim().slice(0,max);
export const treeData=(s:TreeState)=>`directory:tree:${s.chat}:${s.entrance}:${s.floor}:${s.unit}:${s.page}`;
export const unitState=(p:Premise,page=0):TreeState=>({chat:p.chat_id,entrance:p.kind==='commercial'?'c':p.entrance===null?UNKNOWN:String(p.entrance),floor:p.kind==='commercial'?ROOT:p.floor===null?UNKNOWN:String(p.floor),unit:p.id,page});
export function parseTreeState(parts:string[]):TreeState|null{
  const [chat,entrance,floor,unit,page,...extra]=parts;
  if(extra.length||!/^-[1-9]\d*$/.test(chat||'')||!['-','n','c','1','2','3'].includes(entrance)||!(/^(?:-|n|\d{1,2})$/).test(floor||'')||!/^\d+$/.test(unit||'')||!/^\d+$/.test(page||''))return null;
  const s={chat:Number(chat),entrance,floor,unit:Number(unit),page:Number(page)};
  return Number.isSafeInteger(s.chat)&&Number.isSafeInteger(s.unit)&&Number.isSafeInteger(s.page)&&s.page<=100000?s:null;
}
const action=(text:string,data:string)=>`<tg-button type="callback_data" style="link" data="${escapeHtml(data)}">${escapeHtml(text)}</tg-button>`;
async function show(env:Env,text:string,buttons:Button[][],messageId?:number){
  const controls=buttons.map(row=>`<p>${row.map(b=>b.callback_data?action(b.text,b.callback_data):escapeHtml(b.text)).join(' · ')}</p>`).join('');
  return telegram(env,messageId?'editMessageText':'sendRichMessage',{
    chat_id:env.ADMIN_TELEGRAM_USER_ID,...(messageId?{message_id:messageId,reply_markup:{inline_keyboard:[]}}:{}),
    rich_message:{html:`<p>${text.replace(/\n/g,'<br/>')}</p>${controls}`},
  });
}
export async function residentTree(env:Env,s:TreeState,messageId?:number){
  const group=await getGroup(env,s.chat);
  if(!isConnected(group))return show(env,'Будинок недоступний.',[],messageId);
  const units=(await env.HOME_DB.prepare(`SELECT p.*,COUNT(m.id) member_count FROM premises p JOIN memberships m ON m.premise_id=p.id AND m.status IN ('approved','pending') WHERE p.chat_id=? GROUP BY p.id ORDER BY p.kind,p.entrance,p.floor,p.number_start,p.number,p.business_name`).bind(s.chat).all<TreeUnit>()).results;
  if(!units.length)return show(env,'Мешканців ще немає.',[],messageId);
  const branchKey=(p:Premise)=>p.kind==='commercial'?'c':p.entrance===null?UNKNOWN:String(p.entrance);
  const floorKey=(p:Premise)=>p.floor===null?UNKNOWN:String(p.floor);
  const branches=[...new Set(units.map(branchKey))];
  const branchUnits=units.filter(p=>branchKey(p)===s.entrance);
  if(s.entrance!==ROOT&&!branchUnits.length)return show(env,'Ця гілка вже недоступна.',[[{text:'До будинку',callback_data:treeData({...s,entrance:ROOT,floor:ROOT,unit:0,page:0})}]],messageId);
  const floors=[...new Set(branchUnits.map(floorKey))];
  const levelUnits=s.entrance==='c'?branchUnits:branchUnits.filter(p=>floorKey(p)===s.floor);
  if(s.entrance!=='c'&&s.floor!==ROOT&&!levelUnits.length)return show(env,'Поверх уже недоступний.',[[{text:'До під’їзду',callback_data:treeData({...s,floor:ROOT,unit:0,page:0})}]],messageId);
  const selected=s.unit?levelUnits.find(p=>p.id===s.unit):undefined;
  if(s.unit&&!selected)return show(env,'Приміщення недоступне.',[],messageId);
  const unitPage=selected?Math.floor(levelUnits.indexOf(selected)/UNITS_PER_PAGE):Math.min(s.page,Math.max(0,Math.ceil(levelUnits.length/UNITS_PER_PAGE)-1));
  const visibleUnits=levelUnits.slice(unitPage*UNITS_PER_PAGE,(unitPage+1)*UNITS_PER_PAGE);
  const peoplePage=selected?Math.min(s.page,Math.max(0,Math.ceil(selected.member_count/PEOPLE_PER_PAGE)-1)):0;
  const people=selected?(await env.HOME_DB.prepare(`SELECT m.*,u.name,u.phone,u.telegram_username FROM memberships m JOIN profiles u ON u.id=m.profile_id WHERE m.premise_id=? AND m.status IN ('approved','pending') ORDER BY u.name,m.id LIMIT ? OFFSET ?`).bind(selected.id,PEOPLE_PER_PAGE+1,peoplePage*PEOPLE_PER_PAGE).all<Membership>()).results:[];
  const base={...s,unit:0,page:0};
  const root={...base,entrance:ROOT,floor:ROOT};
  const branchAction=(text:string,state:TreeState)=>action(text,treeData(state));
  const lines=[`🏠 ${branchAction(clean(group.title,80),root)}`];
  const line=(prefix:string,content:string)=>lines.push(`<code>${prefix.replace(/ /g,' ')}</code>${content}`);
  const peopleLines=(prefix:string)=>{
    people.slice(0,PEOPLE_PER_PAGE).forEach((m,i)=>{
      const last=i===Math.min(people.length,PEOPLE_PER_PAGE)-1;
      const details=prefix+(last?'   ':'│  ');
      line(prefix+(last?'└─ ':'├─ '),`👤 ${m.user_id?telegramProfileLink(m.user_id,clean(m.name,100),m.telegram_username):escapeHtml(clean(m.name,100))}`);
      line(details,`${roleIcon(m.role)} ${roleLabel(m.role)}${m.status==='pending'?' · ⏳ Заявка':''}`);
      if(m.telegram_username)line(details,telegramProfileLink(m.user_id,`@${m.telegram_username}`,m.telegram_username));
      line(details,`📞 ${escapeHtml(m.phone)}`);
      if(!m.user_id)line(details,'⏳ Не підтвердив реєстрацію');
    });
    const nav:string[]=[];
    if(peoplePage>0)nav.push(branchAction('← Мешканці',{...s,page:peoplePage-1}));
    if(people.length>PEOPLE_PER_PAGE)nav.push(branchAction('Мешканці →',{...s,page:peoplePage+1}));
    if(nav.length)line(prefix,nav.join(' · '));
  };
  const unitLines=(prefix:string)=>{
    if(unitPage>0)line(prefix,branchAction('← Попередні приміщення',{...base,page:unitPage-1}));
    visibleUnits.forEach((p,i)=>{
      const last=i===visibleUnits.length-1;const tail=last?'└─ ':'├─ ';const open=p.id===s.unit;
      const name=p.kind==='commercial'?clean(p.business_name,60):`Кв. ${p.number}`;
      line(prefix+tail,branchAction(`${open?'▾':'▸'} ${name}`,{...base,unit:open?0:p.id,page:open?unitPage:0}));
      if(open)peopleLines(prefix+(last?'   ':'│  '));
    });
    if(levelUnits.length>(unitPage+1)*UNITS_PER_PAGE)line(prefix,branchAction('Наступні приміщення →',{...base,page:unitPage+1}));
  };
  branches.forEach((branch,i)=>{
    const last=i===branches.length-1;const prefix=last?'   ':'│  ';const open=branch===s.entrance;
    const title=branch==='c'?'Комерція':branch===UNKNOWN?'Під’їзд не вказано':`Під’їзд ${branch}`;
    line(last?'└─ ':'├─ ',branchAction(`${open?'▾':'▸'} ${title}`,open?root:{...root,entrance:branch}));
    if(!open)return;
    if(branch==='c'){unitLines(prefix);return;}
    floors.forEach((floor,j)=>{
      const end=j===floors.length-1;const expanded=floor===s.floor;
      const title=floor===UNKNOWN?'Поверх не вказано':`Поверх ${floor}`;
      line(prefix+(end?'└─ ':'├─ '),branchAction(`${expanded?'▾':'▸'} ${title}`,{...base,floor:expanded?ROOT:floor}));
      if(expanded)unitLines(prefix+(end?'   ':'│  '));
    });
  });
  return show(env,lines.join('\n'),[],messageId);
}
export async function unitTree(env:Env,id:number,page:number,messageId?:number){
  const p=await env.HOME_DB.prepare('SELECT * FROM premises WHERE id=?').bind(id).first<Premise>();
  return p?residentTree(env,unitState(p,page),messageId):show(env,'Приміщення недоступне.',[],messageId);
}

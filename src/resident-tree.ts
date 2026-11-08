import type { Button, Env } from './env.ts';
import { getGroup, isConnected } from './groups.ts';
import { escapeHtml } from './presentation.ts';
import { membershipSelect, roleLabel } from './premises.ts';
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
async function show(env:Env,text:string,buttons:Button[][],messageId?:number){
  return telegram(env,messageId?'editMessageText':'sendMessage',{
    chat_id:env.ADMIN_TELEGRAM_USER_ID,...(messageId?{message_id:messageId}:{}),text,parse_mode:'HTML',reply_markup:{inline_keyboard:buttons},
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
  const people=selected?(await env.HOME_DB.prepare(`${membershipSelect.replace('SELECT p.*','SELECT u.telegram_username,p.*')} WHERE p.id=? AND m.status IN ('approved','pending') ORDER BY u.name,m.id LIMIT ? OFFSET ?`).bind(selected.id,PEOPLE_PER_PAGE+1,peoplePage*PEOPLE_PER_PAGE).all<Membership>()).results:[];
  const lines=[`🏠 <b>${escapeHtml(clean(group.title,80))}</b>`];
  const line=(prefix:string,content:string)=>lines.push(`<code>${prefix.replace(/ /g,' ')}</code>${content}`);
  const peopleLines=(prefix:string)=>{
    people.slice(0,PEOPLE_PER_PAGE).forEach((m,i)=>{
      const last=i===Math.min(people.length,PEOPLE_PER_PAGE)-1;
      const nick=m.telegram_username?` · @${escapeHtml(m.telegram_username)}`:'';
      line(prefix+(last?'└── ':'├── '),`${escapeHtml(clean(m.name,100))}${nick} · ${roleLabel(m.role)}${m.status==='pending'?' · ⏳ Заявка':''}`);
      line(prefix+(last?'    ':'│   '),`📞 ${escapeHtml(m.phone)}`);
    });
    if(people.length>PEOPLE_PER_PAGE)line(prefix,'… інші мешканці на наступній сторінці');
  };
  const unitLines=(prefix:string)=>{
    if(unitPage>0)line(prefix,'…');
    visibleUnits.forEach((p,i)=>{
      const last=i===visibleUnits.length-1;const tail=last?'└── ':'├── ';
      const name=p.kind==='commercial'?clean(p.business_name,60):`Кв. ${p.number}`;
      line(prefix+tail,`${escapeHtml(name)}${p.id===s.unit?'':` · ${p.member_count}`}`);
      if(p.id===s.unit)peopleLines(prefix+(last?'    ':'│   '));
    });
    if(levelUnits.length>(unitPage+1)*UNITS_PER_PAGE)line(prefix,'…');
  };
  branches.forEach((branch,i)=>{
    const last=i===branches.length-1;const prefix=last?'    ':'│   ';
    line(last?'└── ':'├── ',`<b>${branch==='c'?'Комерція':branch===UNKNOWN?'Під’їзд не вказано':`Під’їзд ${branch}`}</b>`);
    if(branch!==s.entrance)return;
    if(branch==='c'){unitLines(prefix);return;}
    floors.forEach((floor,j)=>{
      const end=j===floors.length-1;
      line(prefix+(end?'└── ':'├── '),floor===UNKNOWN?'Поверх не вказано':`Поверх ${floor}`);
      if(floor===s.floor)unitLines(prefix+(end?'    ':'│   '));
    });
  });
  const buttons:Button[][]=[];
  const add=(text:string,state:TreeState)=>buttons.push([{text,callback_data:treeData(state)}]);
  const base={...s,unit:0,page:0};
  if(selected){
    for(const m of people.slice(0,PEOPLE_PER_PAGE))buttons.push([{text:`${clean(m.name,36)} · ${roleLabel(m.role)}`,callback_data:`directory:person:${m.membership_id}`}]);
    const nav:Button[]=[];
    if(peoplePage>0)nav.push({text:'← Мешканці',callback_data:treeData({...s,page:peoplePage-1})});
    if(people.length>PEOPLE_PER_PAGE)nav.push({text:'Мешканці →',callback_data:treeData({...s,page:peoplePage+1})});
    if(nav.length)buttons.push(nav);
    add('← Згорнути приміщення',{...base,page:unitPage});
  }else if(s.entrance==='c'||s.floor!==ROOT){
    for(const p of visibleUnits)add(p.kind==='commercial'?clean(p.business_name,50):`Квартира ${p.number} · ${p.member_count}`,{...base,unit:p.id});
    const nav:Button[]=[];
    if(unitPage>0)nav.push({text:'← Назад',callback_data:treeData({...base,page:unitPage-1})});
    if(levelUnits.length>(unitPage+1)*UNITS_PER_PAGE)nav.push({text:'Далі →',callback_data:treeData({...base,page:unitPage+1})});
    if(nav.length)buttons.push(nav);
    add(s.entrance==='c'?'← Згорнути комерцію':'← Згорнути поверх',s.entrance==='c'?{...base,entrance:ROOT,floor:ROOT}:{...base,floor:ROOT});
  }else if(s.entrance!==ROOT){
    for(const floor of floors)add(floor===UNKNOWN?'Поверх не вказано':`Поверх ${floor}`,{...base,floor});
    add('← Згорнути під’їзд',{...base,entrance:ROOT,floor:ROOT});
  }else{
    for(const branch of branches)add(branch==='c'?'Комерція':branch===UNKNOWN?'Під’їзд не вказано':`Під’їзд ${branch}`,{...base,entrance:branch});
  }
  return show(env,lines.join('\n'),buttons,messageId);
}
export async function unitTree(env:Env,id:number,page:number,messageId?:number){
  const p=await env.HOME_DB.prepare('SELECT * FROM premises WHERE id=?').bind(id).first<Premise>();
  return p?residentTree(env,unitState(p,page),messageId):show(env,'Приміщення недоступне.',[],messageId);
}

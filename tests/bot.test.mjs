import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import worker from '../src/index.ts';
import { apartmentNumber, parsePoll, ukrainianPhone } from '../src/validation.ts';
import { entranceForApartment, commercialKey, validFloor } from '../src/premises.ts';
import { pollCard } from '../src/presentation.ts';

function database(until = '9999') {
  const sqlite = new DatabaseSync(':memory:');
  for (const file of readdirSync(new URL('../migrations/',import.meta.url)).filter(f=>f.endsWith('.sql')&&f<until).sort()) sqlite.exec(readFileSync(new URL(`../migrations/${file}`,import.meta.url),'utf8'));
  const db = {
    prepare(sql) {
      let values=[];
      return {
        bind(...args){values=args;return this;},
        async run(){const r=sqlite.prepare(sql).run(...values);return {meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)}};},
        async first(){return sqlite.prepare(sql).get(...values)||null;},
        async all(){return {results:sqlite.prepare(sql).all(...values)};},
      };
    },
    async batch(statements){
      sqlite.exec('BEGIN');
      try{const result=[];for(const s of statements)result.push(await s.run());sqlite.exec('COMMIT');return result;}
      catch(error){sqlite.exec('ROLLBACK');throw error;}
    },
  };
  return {sqlite,db};
}
function harness(groups=1) {
  const {sqlite,db}=database();
  for(let i=1;i<=groups;i++)sqlite.prepare("INSERT INTO groups(chat_id,title,status,bot_present,added_by,version,last_event_id) VALUES (?,?,'approved',1,1,1,1)").run(-100000-i,`House ${i}`);
  const env={HOME_DB:db,TELEGRAM_BOT_TOKEN:'test',TELEGRAM_WEBHOOK_SECRET:'secret',ADMIN_TELEGRAM_USER_ID:'1'};
  const calls=[];let update=1000,message=9000;const oldFetch=globalThis.fetch;
  const h={sqlite,env,calls,fail:null,lastUpdate:null,
    async post(data,secret='secret') {return worker.fetch(new Request('https://home.test/telegram/webhook',{method:'POST',headers:{'Content-Type':'application/json','X-Telegram-Bot-Api-Secret-Token':secret},body:JSON.stringify(data)}),env);},
    async dispatch(data){h.lastUpdate={update_id:++update,...data};const r=await h.post(h.lastUpdate);assert.equal(r.status,200,'Webhook must handle the test update');return h.lastUpdate;},
    async msg(uid,text){return h.dispatch({message:{message_id:++message,chat:{id:uid,type:'private'},from:{id:uid},text}});},
    async cb(uid,data,groupMessage){return h.dispatch({callback_query:{id:String(++message),from:{id:uid},data,message:groupMessage||{message_id:message,chat:{id:uid,type:'private'}}}});},
    form(uid){return sqlite.prepare('SELECT * FROM sessions WHERE user_id=?').get(uid);},
    member(uid,number,chat=-100001,kind='apartment'){return sqlite.prepare('SELECT m.*,p.number,p.chat_id,p.kind FROM memberships m JOIN premises p ON p.id=m.premise_id WHERE m.user_id=? AND p.number=? AND p.chat_id=? AND p.kind=?').get(uid,kind==='commercial'?commercialKey(number):number,chat,kind);},
    nextId(){return ++update;},close(){globalThis.fetch=oldFetch;sqlite.close();},
  };
  globalThis.fetch=async(url,init)=>{
    const method=url.split('/').at(-1);calls.push({method,...JSON.parse(init.body)});
    if(h.fail===method)return Response.json({ok:false},{status:503});
    return Response.json({ok:true,result:{username:'HomeTestBot',message_id:++message}});
  };
  return h;
}
async function register(h,uid,{number='25',kind='apartment',floor='2',entrance='1',business='Coffee & Co',role='owner',chat=-100001,approve=true,phone='067 123 45 67'}={}) {
  await h.msg(uid,`/register group_${Math.abs(chat)}`);
  const token=h.form(uid).token;
  await h.cb(uid,`reg:kind:${token}:${kind}`);
  if(kind==='commercial')await h.msg(uid,business);
  else {await h.msg(uid,number);await h.msg(uid,floor);}
  if(h.form(uid).step==='name')await h.msg(uid,`Person ${uid}`);
  if(h.form(uid).step==='phone')await h.msg(uid,phone);
  await h.cb(uid,`reg:role:${token}:${role}`);
  assert.equal(h.form(uid).step,'review');
  await h.cb(uid,`reg:submit:${token}`);
  const m=h.member(uid,kind==='commercial'?business:number,chat,kind);
  assert.ok(m,'Application must be stored');
  if(approve&&m.status==='pending')await h.cb(1,`review:approve:${m.id}:${m.application_token}`);
  return h.member(uid,kind==='commercial'?business:number,chat,kind);
}
async function poll(h,chat=-100001) {
  await h.msg(1,'🗳 Створити голосування');
  const d=h.sqlite.prepare('SELECT * FROM poll_drafts').get();assert.ok(d);
  if(!d.chat_id){const g=h.sqlite.prepare('SELECT * FROM groups WHERE chat_id=?').get(chat);await h.cb(1,`draft:group:${d.token}:${chat}:${g.version}`);}
  await h.msg(1,'Repair <lift> & entrance?');await h.msg(1,'Yes');await h.msg(1,'No');
  await h.cb(1,`draft:preview:${d.token}`);await h.cb(1,`draft:publish:${d.token}`);
  return h.sqlite.prepare('SELECT * FROM polls ORDER BY id DESC LIMIT 1').get();
}
const groupMessage=p=>({message_id:p.message_id,chat:{id:p.chat_id,type:'supergroup'}});
async function cast(h,uid,p,option){await h.cb(uid,`vote:${p.id}:${option}`,groupMessage(p));}
const currentVotes=h=>h.sqlite.prepare('SELECT * FROM premise_votes ORDER BY premise_id').all();

test('house structure, commercial identities, phones and presentation validation',()=>{
  for(const [n,e] of [['1',1],['84',1],['85',2],['133',2],['134',3],['187',3]])assert.equal(entranceForApartment(n),e);
  for(const n of ['0','188','abc'])assert.equal(entranceForApartment(n),null);
  assert.equal(apartmentNumber(' 00042 '),'42');
  assert.equal(validFloor('apartment',1,'1'),null);assert.equal(validFloor('apartment',1,'14'),14);
  assert.equal(validFloor('apartment',2,'0'),null);assert.equal(validFloor('apartment',2,'9'),9);assert.equal(validFloor('apartment',2,'10'),null);
  assert.equal(validFloor('apartment',3,'10'),10);assert.equal(validFloor('commercial',2,'0'),0);assert.equal(validFloor('commercial',1,'1'),1);
  assert.equal(commercialKey('  АПТЕКА   Здоров’я '),commercialKey('Аптека Здоров’я'));
  for(const value of ['+380671234567','380671234567','067 123 45 67','+38 (067) 123-45-67'])assert.equal(ukrainianPhone(value),'+380671234567');
  for(const value of ['', '+48123456789','+3800671234567','phone:0671234567','+380000000000'])assert.equal(ukrainianPhone(value),null);
  assert.equal(parsePoll('Question | Same | Same'),null);
  const html=pollCard(1,'<b>Question & answer</b>',['<Yes>','No'],new Map(),false);
  assert.ok(html.includes('&lt;b&gt;Question &amp; answer&lt;/b&gt;'));assert.ok(html.includes('&lt;Yes&gt;'));assert.ok(!html.includes('NaN'));
});

test('private registration: preview, invalid floor/phone, back, restart, consent and required fields',async()=>{
  const h=harness();try{
    await h.msg(2,'/start');let s=h.form(2);assert.equal(s.step,'kind');
    await h.cb(2,`reg:submit:${s.token}`);assert.equal(h.sqlite.prepare('SELECT COUNT(*) AS n FROM profiles').get().n,0);
    await h.cb(2,`reg:kind:${s.token}:apartment`);await h.msg(2,'188');assert.equal(h.form(2).step,'number');
    await h.msg(2,'85');assert.equal(JSON.parse(h.form(2).data).entrance,2);
    await h.msg(2,'0');assert.equal(h.form(2).step,'floor');await h.msg(2,'9');await h.msg(2,'Olena Koval');
    await h.msg(2,'+48123456789');assert.equal(h.form(2).step,'phone');await h.msg(2,'067 123 45 67');
    await h.cb(2,`reg:role:${s.token}:tenant`);assert.equal(h.form(2).step,'review');
    assert.equal(h.sqlite.prepare('SELECT COUNT(*) AS n FROM memberships').get().n,0);
    assert.equal(h.calls.some(c=>c.method==='sendMessage'&&String(c.chat_id)==='1'),false,'no private data reaches admin before Submit');
    await h.cb(3,`reg:submit:${s.token}`);assert.equal(h.sqlite.prepare('SELECT COUNT(*) AS n FROM memberships').get().n,0);
    await h.cb(2,`reg:back:${s.token}`);assert.equal(h.form(2).step,'role');await h.cb(2,`reg:role:${s.token}:owner`);
    await h.cb(2,`reg:restart:${s.token}`);assert.notEqual(h.form(2).token,s.token);
    const fresh=h.form(2).token;await h.cb(2,`reg:cancel:${s.token}`);assert.equal(h.form(2).token,fresh);
    await h.cb(2,`reg:cancel:${fresh}`);assert.equal(h.form(2),undefined);
    const m=await register(h,2,{number:'85',floor:'9',approve:false});assert.equal(m.status,'pending');
    await h.cb(3,`review:approve:${m.id}:${m.application_token}`);assert.equal(h.member(2,'85').status,'pending');
    await h.cb(1,`review:approve:${m.id}:${m.application_token}`);assert.equal(h.member(2,'85').status,'approved');
    assert.equal(h.sqlite.prepare('SELECT phone FROM profiles WHERE user_id=2').get().phone,'+380671234567');
    await register(h,2,{number:'85',floor:'9',role:'tenant'});assert.equal(h.member(2,'85').role,'owner','duplicate form cannot downgrade approved membership');
  }finally{h.close();}
});

test('commercial registration uses name only and shares canonical business identity',async()=>{
  const h=harness();try{
    const first=await register(h,2,{kind:'commercial',business:'Coffee & Co'});assert.equal(first.status,'approved');
    const unit=h.sqlite.prepare('SELECT * FROM premises WHERE id=?').get(first.premise_id);
    assert.equal(unit.number,'business:coffee & co');assert.equal(unit.floor,null);assert.equal(unit.entrance,null);assert.equal(unit.business_name,'Coffee & Co');
    const second=await register(h,3,{kind:'commercial',business:'  COFFEE   & CO  '});assert.equal(second.status,'approved');
    assert.equal(second.premise_id,first.premise_id);
    const third=await register(h,2,{kind:'commercial',business:'Аптека'});assert.equal(third.status,'approved');
    assert.notEqual(third.premise_id,first.premise_id);
  }finally{h.close();}
});

test('one premise vote stays in group, live counts update, other resident cannot overwrite, closing freezes results',async()=>{
  const h=harness();try{
    await register(h,2);await register(h,3,{role:'tenant'});const p=await poll(h);
    const published=h.calls.find(c=>c.method==='sendMessage'&&Number(c.chat_id)===p.chat_id);
    assert.equal(published.reply_markup.inline_keyboard.length,2);assert.ok(published.reply_markup.inline_keyboard.flat().every(b=>b.callback_data&&!b.url));
    await cast(h,9,p,0);assert.equal(currentVotes(h).length,0);assert.equal(h.calls.at(-1).url,`https://t.me/HomeTestBot?start=poll_${p.id}`);
    await h.cb(2,`vote:${p.id}:0`,{...groupMessage(p),message_id:99999});assert.equal(currentVotes(h).length,0);
    await cast(h,2,p,0);assert.equal(currentVotes(h).length,1);
    const live=h.calls.filter(c=>c.method==='editMessageText').at(-1);assert.match(live.text,/100%/);assert.equal(live.reply_markup.inline_keyboard[0][0].text,'Yes · 1');
    assert.ok(!live.text.includes('Person'));await cast(h,3,p,1);assert.equal(currentVotes(h)[0].option_index,0);
    assert.match(h.calls.at(-1).text,/Person 2/);assert.match(h.calls.at(-1).text,/Власник/);assert.equal(h.calls.at(-1).method,'answerCallbackQuery');
    await cast(h,2,p,1);assert.equal(currentVotes(h)[0].option_index,1,'only the original author may change their vote');
    await h.msg(1,`/close ${p.id}`);await cast(h,2,p,0);assert.equal(currentVotes(h)[0].option_index,1);
    assert.deepEqual(h.calls.filter(c=>c.method==='editMessageText').at(-1).reply_markup.inline_keyboard,[]);
  }finally{h.close();}
});

test('multiple premises: private intent is user-bound, individual choices differ and all-vote requires confirmation',async()=>{
  const h=harness();try{
    const a=await register(h,2,{number:'25'});const b=await register(h,2,{number:'26'});
    await register(h,3,{number:'26',role:'tenant'});const p=await poll(h);
    await cast(h,2,p,0);assert.equal(currentVotes(h).length,0,'group click must not cast for an arbitrary unit');
    let intent=h.sqlite.prepare('SELECT * FROM vote_intents WHERE user_id=2').get();assert.ok(h.calls.at(-1).url.endsWith(`vote_${intent.token}`));
    await h.msg(2,`/start vote_${intent.token}`);assert.match(h.calls.at(-1).text,/Від якого приміщення/);
    await h.cb(3,`cast:${intent.token}:${a.premise_id}`);assert.equal(currentVotes(h).length,0);
    await h.cb(2,`cast:${intent.token}:${a.premise_id}`);assert.equal(currentVotes(h)[0].option_index,0);
    await cast(h,2,p,1);const next=h.sqlite.prepare('SELECT * FROM vote_intents WHERE user_id=2').get();assert.notEqual(next.token,intent.token);
    await h.cb(2,`cast:${intent.token}:${b.premise_id}`);assert.equal(currentVotes(h).length,1,'old choice token invalidated');
    await h.cb(2,`cast:${next.token}:${b.premise_id}`);assert.deepEqual(currentVotes(h).map(v=>v.option_index),[0,1]);
    await h.cb(2,`va:confirm:${next.token}`);assert.deepEqual(currentVotes(h).map(v=>v.option_index),[0,1],'bulk vote requires confirmation screen first');
    await h.cb(2,`va:ask:${next.token}`);assert.deepEqual(currentVotes(h).map(v=>v.option_index),[0,1]);
    await h.cb(2,`va:confirm:${next.token}`);assert.deepEqual(currentVotes(h).map(v=>v.option_index),[1,1]);
    h.sqlite.prepare('UPDATE vote_intents SET expires_at=0 WHERE token=?').run(next.token);
    await h.cb(2,`cast:${next.token}:${a.premise_id}`);assert.deepEqual(currentVotes(h).map(v=>v.option_index),[1,1]);
    await cast(h,2,p,0);intent=h.sqlite.prepare('SELECT * FROM vote_intents WHERE user_id=2').get();
    await h.msg(1,`/close ${p.id}`);await h.cb(2,`va:confirm:${intent.token}`);assert.deepEqual(currentVotes(h).map(v=>v.option_index),[1,1]);
  }finally{h.close();}
});

test('owners can revoke tenants only in their own premise; pending/foreign owners cannot; closed history remains',async()=>{
  const h=harness();try{
    const owner=await register(h,2);const tenant=await register(h,3,{role:'tenant'});const otherOwner=await register(h,4);
    await register(h,3,{number:'26',role:'owner'});await register(h,5,{number:'26',role:'owner'});
    const pending=await register(h,6,{approve:false});const p=await poll(h);
    await cast(h,3,p,0);let i=h.sqlite.prepare('SELECT * FROM vote_intents WHERE user_id=3').get();
    await h.cb(3,`cast:${i.token}:${tenant.premise_id}`);assert.equal(currentVotes(h).length,1);
    await h.cb(3,`unit:members:${tenant.premise_id}:0`);
    const listing=h.calls.at(-1);assert.ok(!listing.text.includes('+380'),'members cannot see other residents phones');
    await h.cb(6,`unit:members:${pending.premise_id}:0`);assert.match(h.calls.at(-1).text,/після підтвердження/);
    for(const uid of [3,5,6])await h.cb(uid,`unit:remove:${tenant.id}:${tenant.version}`);
    assert.equal(h.member(3,'25').status,'approved');
    await h.cb(2,`unit:remove:${otherOwner.id}:${otherOwner.version}`);assert.equal(h.member(4,'25').status,'approved');
    await h.cb(2,`unit:askremove:${tenant.id}:${tenant.version}`);assert.equal(h.member(3,'25').status,'approved','confirmation is separate');
    await h.cb(2,`unit:remove:${tenant.id}:${tenant.version}`);assert.equal(h.member(3,'25').status,'revoked');assert.equal(h.member(3,'26').status,'approved');
    assert.equal(currentVotes(h).length,1,'revoking access must not remove or replace an already submitted vote');
    assert.equal(currentVotes(h)[0].user_id,3);
    await h.cb(2,`unit:remove:${tenant.id}:${tenant.version}`);assert.equal(h.sqlite.prepare("SELECT COUNT(*) AS n FROM membership_audit WHERE action='revoke'").get().n,1);
    await cast(h,2,p,1);await h.msg(1,`/close ${p.id}`);
    await h.cb(1,`unit:remove:${owner.id}:${owner.version}`);assert.equal(currentVotes(h).length,1,'closed tally is historical');
  }finally{h.close();}
});

test('group isolation, multiple connections, stale connection buttons and disconnect',async()=>{
  const h=harness(2);try{
    await register(h,2);const p2=await poll(h,-100002);await cast(h,2,p2,0);assert.equal(currentVotes(h).length,0);
    await register(h,2,{chat:-100002});await cast(h,2,p2,0);assert.equal(currentVotes(h).length,1);
    await h.cb(1,'admin:groups');assert.match(h.calls.at(-1).text,/Групи/);
    await h.cb(2,'group:disconnect:-100002:1');assert.equal(h.sqlite.prepare('SELECT status FROM groups WHERE chat_id=-100002').get().status,'approved');
    await h.cb(1,'group:askdisconnect:-100002:1');assert.equal(h.sqlite.prepare('SELECT status FROM groups WHERE chat_id=-100002').get().status,'approved');
    await h.cb(1,'group:disconnect:-100002:1');assert.equal(h.sqlite.prepare('SELECT status FROM groups WHERE chat_id=-100002').get().status,'disconnected');
    assert.equal(h.sqlite.prepare('SELECT status FROM groups WHERE chat_id=-100001').get().status,'approved');
    assert.equal(h.sqlite.prepare('SELECT status FROM polls WHERE id=?').get(p2.id).status,'closed');
    await h.cb(1,'group:approve:-100002:1');assert.equal(h.sqlite.prepare('SELECT status FROM groups WHERE chat_id=-100002').get().status,'disconnected');
    const version=h.sqlite.prepare('SELECT version FROM groups WHERE chat_id=-100002').get().version;
    await h.cb(1,`group:approve:-100002:${version}`);assert.equal(h.sqlite.prepare('SELECT status FROM groups WHERE chat_id=-100002').get().status,'approved');
    assert.equal(h.sqlite.prepare('SELECT status FROM polls WHERE id=?').get(p2.id).status,'closed');
  }finally{h.close();}
});

test('admin and resident keyboards route actions without poll/registration input corruption',async()=>{
  const h=harness();try{
    await h.msg(1,'/start');assert.ok(h.calls.at(-1).reply_markup.keyboard);assert.equal(h.calls.at(-1).reply_markup.is_persistent,true);
    assert.ok(h.calls.some(c=>c.method==='setChatMenuButton'&&c.chat_id===1));
    await h.msg(1,'🗳 Створити голосування');const token=h.sqlite.prepare('SELECT token FROM poll_drafts').get().token;
    await h.msg(1,'🗳 Створити голосування');assert.equal(h.sqlite.prepare('SELECT token FROM poll_drafts').get().token,token);
    await h.msg(1,'/cancel');
    await register(h,1);await h.msg(1,'👤 Мої дані');assert.match(h.calls.at(-1).text,/Person 1/);
    await register(h,2);await h.msg(2,'/start');assert.ok(h.calls.at(-1).reply_markup.keyboard);
    await h.msg(2,'🏠 Мої приміщення');assert.match(h.calls.at(-1).text,/Мої приміщення/);
    await h.msg(2,'➕ Додати приміщення');assert.equal(h.form(2).step,'kind');
    await h.msg(2,'👤 Мої дані');assert.equal(h.form(2).step,'kind','menu text cannot become a field value');
    await h.msg(2,'/poll Unauthorized | Yes | No');assert.equal(h.sqlite.prepare('SELECT COUNT(*) AS n FROM polls').get().n,0);
  }finally{h.close();}
});

test('webhook secret, invalid payload, idempotency and Telegram failure retries',async()=>{
  const h=harness();try{
    assert.equal((await h.post({update_id:1},'wrong')).status,403);
    assert.equal((await h.post({update_id:'bad'})).status,400);
    await h.dispatch({message:{message_id:1,chat:{id:-100001,type:'supergroup'},from:{id:2},text:'/start'}});assert.equal(h.calls.length,0);
    await h.msg(1,'/start');const update=h.lastUpdate;const before=h.calls.length;await h.post(update);assert.equal(h.calls.length,before);
    const request={update_id:h.nextId(),message:{message_id:1,chat:{id:1,type:'private'},from:{id:1},text:'/poll Retry | Yes | No'}};
    h.fail='sendMessage';assert.equal((await h.post(request)).status,503);assert.equal(h.sqlite.prepare('SELECT state FROM updates WHERE id=?').get(request.update_id),undefined);
    h.fail=null;assert.equal((await h.post(request)).status,200);assert.equal(h.sqlite.prepare('SELECT COUNT(*) AS n FROM polls').get().n,1);
  }finally{h.close();}
});

test('migration preserves old people, memberships, votes and in-progress legacy forms',()=>{
  const {sqlite}=database('0006');try{
    sqlite.exec(`INSERT INTO groups(chat_id,title,status,bot_present,added_by,version,last_event_id) VALUES (-100001,'House','approved',1,1,1,1);
      INSERT INTO residents(user_id,chat_id,name,apartment,role,status,phone,application_token) VALUES (2,-100001,'Old resident','25','owner','approved','+380671234567','old');
      INSERT INTO polls(source_update_id,question,options,chat_id,status,created_by) VALUES (1,'Old poll','["Yes","No"]',-100001,'open',1);
      INSERT INTO votes(poll_id,apartment,user_id,option_index) VALUES (1,'25',2,1);
      INSERT INTO sessions(user_id,step,chat_id,token) VALUES (3,'phone',-100001,'old-form');`);
    sqlite.exec(readFileSync(new URL('../migrations/0006_premises.sql',import.meta.url),'utf8'));
    assert.equal(sqlite.prepare('SELECT name FROM profiles').get().name,'Old resident');
    assert.equal(sqlite.prepare('SELECT status FROM memberships').get().status,'approved');
    assert.equal(sqlite.prepare('SELECT option_index FROM premise_votes').get().option_index,1);
    assert.equal(sqlite.prepare('SELECT token FROM legacy_registration_sessions').get().token,'old-form');
    assert.equal(sqlite.prepare('PRAGMA foreign_key_check').all().length,0);
  }finally{sqlite.close();}
});

test('revoked membership and newly approved units cannot expand an already confirmed bulk selection',async()=>{
  const h=harness();try{
    const a=await register(h,2,{number:'25'});const b=await register(h,2,{number:'26'});const p=await poll(h);
    await cast(h,2,p,0);const intent=h.sqlite.prepare('SELECT * FROM vote_intents').get();
    await h.cb(2,`va:ask:${intent.token}`);
    const c=await register(h,2,{number:'27'});
    h.sqlite.prepare("UPDATE memberships SET status='revoked',version=version+1 WHERE id=?").run(b.id);
    await h.cb(2,`cast:${intent.token}:${b.premise_id}`);assert.equal(currentVotes(h).length,0);
    await h.cb(2,`va:confirm:${intent.token}`);
    assert.deepEqual(currentVotes(h).map(v=>v.premise_id),[a.premise_id]);
    assert.ok(!currentVotes(h).some(v=>v.premise_id===c.premise_id),'a new unit must not be silently added to prior confirmation');
  }finally{h.close();}
});

test('saved contacts are reused for commerce and additional apartments; commerce asks only name and role',async()=>{
  const h=harness();try{
    await register(h,2);
    await h.msg(2,'➕ Додати приміщення');const token=h.form(2).token;
    await h.cb(2,`reg:kind:${token}:commercial`);assert.equal(h.form(2).step,'business_name');
    await h.msg(2,'Аптека');assert.equal(h.form(2).step,'role');
    await h.cb(2,`reg:role:${token}:owner`);assert.equal(h.form(2).step,'review');
    const review=h.calls.at(-1).text;
    assert.match(review,/Аптека/);assert.match(review,/Person 2/);assert.match(review,/\+380671234567/);
    assert.ok(!review.includes('Під’їзд'));assert.ok(!review.includes('Поверх'));assert.ok(!review.includes('business:'));
    await h.cb(2,`reg:submit:${token}`);
    const business=h.member(2,'Аптека',-100001,'commercial');assert.ok(business);
    await h.cb(1,`review:approve:${business.id}:${business.application_token}`);
    await h.cb(2,`unit:view:${business.premise_id}`);assert.ok(!h.calls.at(-1).text.includes('Під’їзд'));assert.ok(!h.calls.at(-1).text.includes('Поверх'));
    await h.msg(2,'➕ Додати приміщення');const apartmentToken=h.form(2).token;
    await h.cb(2,`reg:kind:${apartmentToken}:apartment`);await h.msg(2,'68');await h.msg(2,'10');
    assert.equal(h.form(2).step,'role','existing name and phone must not be requested again for an apartment');
    await h.cb(2,`reg:back:${apartmentToken}`);assert.equal(h.form(2).step,'floor');
    await h.msg(2,'11');await h.cb(2,`reg:role:${apartmentToken}:owner`);await h.cb(2,`reg:restart:${apartmentToken}`);
    const restart=h.form(2).token;await h.cb(2,`reg:kind:${restart}:commercial`);await h.msg(2,'Кав’ярня');assert.equal(h.form(2).step,'role');
  }finally{h.close();}
});

test('in-progress commerce from old form skips location and saved contacts after upgrade',async()=>{
  const h=harness();try{
    await register(h,2);
    h.sqlite.prepare("INSERT INTO sessions(user_id,chat_id,token,step,data) VALUES (2,-100001,'old-form','entrance',?)").run(JSON.stringify({kind:'commercial',number:'7-8',business_name:'Аптека'}));
    await h.msg(2,'2');assert.equal(h.form(2).step,'role');
    const data=JSON.parse(h.form(2).data);assert.equal(data.name,'Person 2');assert.equal(data.phone,'+380671234567');assert.equal(data.entrance,undefined);assert.equal(data.floor,undefined);
  }finally{h.close();}
});

test('owner and co-owner cannot replace tenant vote; author name and role are shown privately and remain a snapshot',async()=>{
  const h=harness();try{
    await register(h,2);await register(h,3,{role:'tenant'});await register(h,4);
    const p=await poll(h);await cast(h,3,p,0);
    for(const uid of [2,4]){
      await cast(h,uid,p,1);assert.equal(currentVotes(h)[0].option_index,0);assert.equal(currentVotes(h)[0].user_id,3);
      const notice=h.calls.at(-1);assert.equal(notice.method,'answerCallbackQuery');assert.match(notice.text,/Person 3/);assert.match(notice.text,/Орендар/);assert.match(notice.text,/попросіть змінити свій голос/);assert.ok(notice.text.length<=200);assert.ok(!notice.text.includes('+380'));
    }
    h.sqlite.prepare("UPDATE profiles SET name='Changed name' WHERE user_id=3").run();
    h.sqlite.prepare("UPDATE memberships SET role='owner' WHERE user_id=3").run();
    await cast(h,2,p,1);assert.match(h.calls.at(-1).text,/Person 3/);assert.match(h.calls.at(-1).text,/Орендар/);
    const publicEdits=h.calls.filter(c=>c.method==='editMessageText');assert.equal(publicEdits.length,1);assert.ok(!publicEdits[0].text.includes('Person'));
  }finally{h.close();}
});

test('bulk vote changes only the requesting authors own votes',async()=>{
  const h=harness();try{
    const a=await register(h,2,{number:'25'});const b=await register(h,2,{number:'26'});const p=await poll(h);
    await cast(h,2,p,0);let intent=h.sqlite.prepare('SELECT * FROM vote_intents WHERE user_id=2').get();
    await h.cb(2,`cast:${intent.token}:${a.premise_id}`);
    await cast(h,2,p,1);intent=h.sqlite.prepare('SELECT * FROM vote_intents WHERE user_id=2').get();
    await h.cb(2,`va:ask:${intent.token}`);await h.cb(2,`va:confirm:${intent.token}`);
    assert.equal(currentVotes(h).find(v=>v.premise_id===a.premise_id).option_index,1);
    assert.equal(currentVotes(h).find(v=>v.premise_id===b.premise_id).option_index,1);
    assert.match(h.calls.at(-1).text,/Person 2/);
  }finally{h.close();}
});

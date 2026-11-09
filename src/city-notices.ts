import type { Env } from './env.ts';
import { escapeHtml } from './presentation.ts';
import { telegram } from './telegram.ts';

const source = 'https://1562.kharkivrada.gov.ua/ajax/inform/informList-v2.php';
const address = {
  streetid: '9993', skyscraperid: '66540',
  street: 'Героїв Харкова просп., м.Харків', house: '158',
};
// The endpoint requires explicit categories, even for the portal’s “all works” filter.
const informTypes = [
  794,795,796,797,798,799,800,801,802,803,804,805,806,807,808,
  809,810,811,812,814,815,816,817,818,819,820,821,822,823,824,
  825,826,833,834,844,845,849,850,852,855,856,857,858,859,860,
  861,862,863,864,865,866,867,868,870,873,874,875,876,878,879,
  880,881,882,883,884,885,887,888,889,890,896,897,898,900,902,
  903,906,907,908,909,912,913,915,918,919,
];
const entities: Record<string,string> = {amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' ',ndash:'–',mdash:'—'};
interface Notice { id: number; title: string; body: string; start: string; end: string; finished: string }
interface SavedNotice { message_id: number | null; content_hash: string; starts_at: string; ends_at: string }

function plainText(html: string) {
  return html.replace(/<br\s*\/?>/gi,'\n').replace(/<[^>]*>/g,'')
    .replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi,(entity,code:string)=>{
      if(!code.startsWith('#'))return entities[code] ?? entity;
      const number = code[1].toLowerCase()==='x' ? parseInt(code.slice(2),16) : Number(code.slice(1));
      return number>0 && number<=0x10ffff ? String.fromCodePoint(number) : entity;
    }).replace(/\r\n/g,'\n').trim();
}

function parsePage(html: string) {
  const cursor = html.match(/<loadedID\b[^>]*>\s*(-1|\d+)\s*<\/loadedID>/i);
  if(!cursor)throw new Error('Unexpected 1562 response');
  const cards = [...html.matchAll(/<div\b[^>]*\bid=["']infoId(\d+)["'][^>]*>/gi)];
  if(!cards.length && Number(cursor[1])!==-1)throw new Error('Missing 1562 cards');
  const notices = cards.map((match,index):Notice=>{
    const card = html.slice(match.index,cards[index+1]?.index);
    const title = plainText(card.match(/<h5\b[^>]*>([\s\S]*?)<\/h5>/i)?.[1] ?? '').replace(/\s+/g,' ');
    if(!title)throw new Error('Missing 1562 notice title');
    const body = plainText(card.match(/<pre\b[^>]*>([\s\S]*?)<\/pre>/i)?.[1] ?? '');
    const dates = [...card.matchAll(/<p\b[^>]*\btitleDate\b[^>]*>([\s\S]*?)<\/p>/gi)].map(x=>plainText(x[1]));
    const date = (label:string) => dates.find(x=>x.startsWith(label))?.slice(label.length).trim() ?? '';
    return {id:Number(match[1]),title,body,start:date('Початок:'),end:date('Заплановано:'),finished:date('Кінець:')};
  });
  return {notices,next:Number(cursor[1])};
}

async function readNotices(now: Date) {
  const kyiv = new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Kyiv',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
  const today = Date.parse(kyiv+'T00:00:00Z');
  const date = (offset:number) => new Date(today+offset*86_400_000).toISOString().slice(0,10).replace(/-/g,'/');
  const notices = new Map<number,Notice>();
  let cursor = 0;
  const visited = new Set<number>();
  while(cursor!==-1) {
    if(visited.has(cursor) || visited.size>=20)throw new Error('Invalid 1562 pagination');
    visited.add(cursor);
    const form = new FormData();
    const filter = new URLSearchParams({ ...address, from:date(-1),to:date(30),
      radio1580works:'1',radio1580datetype:'1',DistributionPointCountAll:'9' });
    for(const type of informTypes)filter.append('InformType[]',String(type));
    for(const [key,value] of Object.entries({
      data:filter.toString(),rn:String(cursor),all:'1',isFrame:'',hr:'1',ls:'0',conf:'0',frameJeoId:'0',
    }))form.set(key,value);
    const response = await fetch(source,{method:'POST',body:form,signal:AbortSignal.timeout(8_000)});
    if(!response.ok)throw new Error(`1562 returned HTTP ${response.status}`);
    const page = parsePage(await response.text());
    for(const notice of page.notices)notices.set(notice.id,notice);
    cursor = page.next;
  }
  return notices;
}

function noticeText(notice: Notice) {
  return [
    '🔴 <b>1562 · просп. Героїв Харкова, 158</b>',
    `<b>${escapeHtml(notice.title)}</b>`,
    notice.body ? escapeHtml(notice.body) : '',
    [notice.start && `Початок: ${escapeHtml(notice.start)}`,
      notice.end && `Планове завершення: ${escapeHtml(notice.end)}`,
      notice.finished && `Фактичне завершення: ${escapeHtml(notice.finished)}`].filter(Boolean).join('\n'),
  ].filter(Boolean).join('\n\n');
}

const completionDay = new Intl.DateTimeFormat('uk-UA',{timeZone:'UTC',day:'numeric',month:'long'});

function completionText(notice: Notice) {
  const date = /^(\d{2})\.(\d{2})\.(\d{2}) (\d{1,2}:\d{2})$/.exec(notice.finished);
  const time = date
    ? `${completionDay.format(Date.UTC(2000+Number(date[3]),Number(date[2])-1,Number(date[1])))} о ${date[4]}`
    : notice.finished;
  return `🟢 <b>1562 · Роботи завершено</b>\n${escapeHtml(notice.title)}\nФактичне завершення: <b>${escapeHtml(time)}</b>`;
}

function updateText(previous: SavedNotice, notice: Notice) {
  const lines = ['🔴 <b>1562 · Оновлення</b>'];
  for(const [label,before,after] of [
    ['Початок',previous.starts_at,notice.start],
    ['Завершення',previous.ends_at,notice.end],
  ]) {
    if(before===after)continue;
    if(!after)lines.push(`${label} робіт: час уточнюється.`);
    else if(!before)lines.push(`${label} робіт заплановано на <b>${escapeHtml(after)}</b>.`);
    else {
      const sameDay = before.includes(' ') && before.split(' ')[0]===after.split(' ')[0];
      lines.push(`${label} робіт перенесли з <b>${escapeHtml(sameDay?before.split(' ').at(-1)!:before)}</b> на <b>${escapeHtml(sameDay?after.split(' ').at(-1)!:after)}</b>.`);
    }
  }
  if(lines.length===1)lines.push('Текст оголошення оновлено.');
  return lines.join('\n');
}

async function publishNotice(env: Env, chat: number, notice: Notice) {
  const db = env.HOME_DB;
  if(notice.finished) {
    const published = await db.prepare('SELECT ends_at FROM city_notices WHERE chat_id=? AND notice_id=? AND message_id IS NOT NULL')
      .bind(chat,notice.id).first<{ends_at:string}>();
    if(!published)return;
    notice = {...notice,end:notice.end || published.ends_at};
  }
  const text = noticeText(notice);
  const digest = await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text));
  const hash = Array.from(new Uint8Array(digest),x=>x.toString(16).padStart(2,'0')).join('');
  const claimed = await db.prepare(`INSERT INTO city_notices(chat_id,notice_id,lease_until)
    VALUES (?,?,unixepoch()+120)
    ON CONFLICT(chat_id,notice_id) DO UPDATE SET lease_until=unixepoch()+120
    WHERE city_notices.lease_until<=unixepoch() AND city_notices.content_hash<>?
      AND (city_notices.message_id IS NOT NULL OR city_notices.content_hash='')`)
    .bind(chat,notice.id,hash).run();
  if(!claimed.meta.changes)return;
  try {
    const saved = await db.prepare('SELECT message_id,content_hash,starts_at,ends_at FROM city_notices WHERE chat_id=? AND notice_id=?')
      .bind(chat,notice.id).first<SavedNotice>();
    let messageId = saved?.message_id;
    if(messageId && saved) {
      await telegram(env,'editMessageText',{chat_id:chat,message_id:messageId,text,parse_mode:'HTML'});
      await telegram(env,'sendMessage',{chat_id:chat,text:notice.finished ? completionText(notice) : updateText(saved,notice),parse_mode:'HTML',
        reply_parameters:{message_id:messageId}});
    } else {
      const sent = await telegram<{message_id:number}>(env,'sendMessage',{chat_id:chat,text,parse_mode:'HTML'});
      messageId = sent.message_id;
    }
    await db.prepare(`UPDATE city_notices SET message_id=?,content_hash=?,starts_at=?,ends_at=?,lease_until=0
      WHERE chat_id=? AND notice_id=?`).bind(messageId,hash,notice.start,notice.end,chat,notice.id).run();
  } catch(error) {
    await db.prepare('UPDATE city_notices SET lease_until=0 WHERE chat_id=? AND notice_id=?').bind(chat,notice.id).run();
    throw error;
  }
}

export async function scheduledCityNotices(env: Env, now = new Date()) {
  const db = env.HOME_DB;
  const destination = await db.prepare(`SELECT chat_id FROM groups
    WHERE city_notices_enabled=1 AND status='approved' AND bot_present=1`).first<{chat_id:number}>();
  if(!destination)return;
  const chat = destination.chat_id;
  const notices = await readNotices(now);
  if(!await db.prepare(`SELECT 1 FROM groups WHERE chat_id=? AND city_notices_enabled=1
    AND status='approved' AND bot_present=1`).bind(chat).first())return;
  // Notice zero records a completed first scan, even when there were no notices.
  if(!await db.prepare('SELECT 1 FROM city_notices WHERE chat_id=? AND notice_id=0').bind(chat).first()) {
    const seed = [...notices.keys()].map(id=>db.prepare(`INSERT OR IGNORE INTO city_notices(chat_id,notice_id,content_hash)
      SELECT ?,?,'seen' WHERE NOT EXISTS (SELECT 1 FROM city_notices WHERE chat_id=? AND notice_id=0)`).bind(chat,id,chat));
    await db.batch([...seed,db.prepare('INSERT OR IGNORE INTO city_notices(chat_id,notice_id) VALUES (?,0)').bind(chat)]);
    return;
  }
  for(const notice of notices.values()) {
    try { await publishNotice(env,chat,notice); }
    catch(error) { console.error('1562 notice delivery failed',notice.id,error); }
  }
}

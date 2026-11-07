import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import worker from '../src/index.ts';
import { apartmentNumber, parsePoll } from '../src/validation.ts';

// Run the real migration and SQL against SQLite; mock only D1's transport and Telegram.
function database(seedGroup = true) {
  const sqlite = new DatabaseSync(':memory:');
  for (const file of readdirSync(new URL('../migrations/', import.meta.url)).filter(f => f.endsWith('.sql')).sort()) {
    sqlite.exec(readFileSync(new URL(`../migrations/${file}`, import.meta.url), 'utf8'));
  }
  if (seedGroup) sqlite.exec("INSERT INTO groups(chat_id,title,status,bot_present,added_by,version,last_event_id) VALUES (-100123,'Test House','approved',1,1,1,1)");
  const db = {
    prepare(sql) {
      let values = [];
      return {
        bind(...args) { values = args; return this; },
        async run() {
          const result = sqlite.prepare(sql).run(...values);
          return { meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
        },
        async first() { return sqlite.prepare(sql).get(...values) || null; },
        async all() { return { results: sqlite.prepare(sql).all(...values) }; },
      };
    },
    async batch(statements) {
      sqlite.exec('BEGIN');
      try { const result = []; for (const s of statements) result.push(await s.run()); sqlite.exec('COMMIT'); return result; }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  };
  return { sqlite, db };
}

test('registration, approval, apartment vote uniqueness, retries and closing', async () => {
  const { sqlite, db } = database();
  const env = { HOME_DB: db, TELEGRAM_BOT_TOKEN: 'test', TELEGRAM_WEBHOOK_SECRET: 'secret', ADMIN_TELEGRAM_USER_ID: '1' };
  const calls = [];
  const originalFetch = globalThis.fetch;
  let messageId = 100;
  globalThis.fetch = async (url, init) => {
    calls.push({ method: url.split('/').at(-1), ...JSON.parse(init.body) });
    return Response.json({ ok: true, result: { username: 'HomeTestBot', message_id: ++messageId } });
  };
  let updateId = 0;
  async function post(update, secret = 'secret') {
    return worker.fetch(new Request('https://home.test/telegram/webhook', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': secret },
      body: JSON.stringify(update),
    }), env);
  }
  async function message(uid, text, type = 'private') {
    const update = { update_id: ++updateId, message: { message_id: updateId, from: { id: uid }, chat: { id: type === 'private' ? uid : -100123, type }, text } };
    assert.equal((await post(update)).status, 200);
    return update;
  }
  async function callback(uid, data, groupMessage) {
    if (/^role:(owner|tenant)$/.test(data)) data += ':' + sqlite.prepare('SELECT token FROM sessions WHERE user_id=?').get(uid).token;
    if (/^approve:\d+$/.test(data)) {
      const target = Number(data.split(':')[1]);
      const resident = sqlite.prepare('SELECT * FROM residents WHERE user_id=?').get(target);
      data += `:${resident.chat_id}:${resident.application_token}`;
    }
    const update = { update_id: ++updateId, callback_query: { id: String(updateId), from: { id: uid }, data,
      message: groupMessage || { message_id: 5, chat: { id: uid, type: 'private' } } } };
    assert.equal((await post(update)).status, 200);
    return update;
  }
  try {
    assert.equal((await post({ update_id: 900 }, 'wrong')).status, 403);
    assert.equal((await post({ update_id: 'bad' })).status, 400);
    await message(2, '/start', 'supergroup');
    assert.equal(calls.length, 0);
    await message(2, '/poll Forbidden | Yes | No');
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM polls').get().n, 0);
    for (const uid of [2, 3]) {
      await message(uid, '/start'); await message(uid, `Resident ${uid}`); await message(uid, '001');
      await callback(uid, 'role:owner');
      assert.equal(sqlite.prepare('SELECT status FROM residents WHERE user_id=?').get(uid).status, 'pending');
      await callback(3, `approve:${uid}`);
      assert.equal(sqlite.prepare('SELECT status FROM residents WHERE user_id=?').get(uid).status, 'pending');
      await callback(1, `approve:${uid}`);
    }
    const created = await message(1, '/poll Ремонт? | Так | Ні');
    const count = calls.length;
    await post(created);
    assert.equal(calls.length, count, 'completed update must not send again');
    const poll = sqlite.prepare('SELECT * FROM polls').get();
    const group = { message_id: poll.message_id, chat: { id: -100123, type: 'supergroup' } };
    await callback(9, `vote:${poll.id}:0`, group);
    assert.equal(calls.at(-1).url, `https://t.me/HomeTestBot?start=poll_${poll.id}`);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM votes').get().n, 0);
    await callback(2, `vote:${poll.id}:99`, group);
    await callback(2, `vote:${poll.id}:0`, { ...group, message_id: 99999 });
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM votes').get().n, 0);
    await callback(2, `vote:${poll.id}:0`, group);
    await callback(3, `vote:${poll.id}:1`, group);
    assert.equal(sqlite.prepare('SELECT option_index FROM votes').get().option_index, 0);
    await callback(2, `vote:${poll.id}:1`, group);
    assert.equal(sqlite.prepare('SELECT option_index FROM votes').get().option_index, 1);
    await message(1, `/close ${poll.id}`);
    await callback(2, `vote:${poll.id}:0`, group);
    assert.equal(sqlite.prepare('SELECT option_index FROM votes').get().option_index, 1);
    const edit = calls.find(c => c.method === 'editMessageText');
    assert.deepEqual(edit.reply_markup.inline_keyboard, []);
    assert.match(edit.text, /Ні: 1/);
    assert.ok(calls.filter(c => c.method === 'sendMessage' && Number(c.chat_id) === -100123).every(c => !c.text.includes('Resident')));
  } finally { globalThis.fetch = originalFetch; sqlite.close(); }
});

test('numeric apartment identities and poll validation', () => {
  assert.equal(apartmentNumber(' 00042 '), '42');
  for (const value of ['0', '42a', '-1', '1.5', '100000', '']) assert.equal(apartmentNumber(value), null);
  assert.equal(parsePoll('Question | Same | Same'), null);
  assert.equal(parsePoll('Question | Only'), null);
  assert.deepEqual(parsePoll(' Question | Yes | No '), { question: 'Question', options: ['Yes', 'No'] });
});

test('Telegram failure returns retry status and releases update claim', async () => {
  const { sqlite, db } = database();
  const env = { HOME_DB: db, TELEGRAM_BOT_TOKEN: 'test', TELEGRAM_WEBHOOK_SECRET: 'secret', ADMIN_TELEGRAM_USER_ID: '1' };
  const oldFetch = globalThis.fetch;
  const update = { update_id: 77, message: { message_id: 1, from: { id: 1 }, chat: { id: 1, type: 'private' }, text: '/poll Тест | Так | Ні' } };
  const request = () => new Request('https://home.test/telegram/webhook', { method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': 'secret' }, body: JSON.stringify(update) });
  try {
    globalThis.fetch = async () => Response.json({ ok: false }, { status: 503 });
    assert.equal((await worker.fetch(request(), env)).status, 503);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM updates').get().n, 0);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM polls').get().n, 1);
    globalThis.fetch = async () => Response.json({ ok: true, result: { username: 'HomeTestBot', message_id: 123 } });
    assert.equal((await worker.fetch(request(), env)).status, 200);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM polls').get().n, 1);
    assert.equal(sqlite.prepare('SELECT status FROM polls').get().status, 'open');
    assert.equal(sqlite.prepare('SELECT state FROM updates').get().state, 'done');
  } finally { globalThis.fetch = oldFetch; sqlite.close(); }
});

test('admin button wizard requires preview and confirmation; stale and foreign buttons cannot publish', async () => {
  const { handleUpdate } = await import('../src/index.ts');
  const { sqlite, db } = database();
  const env = { HOME_DB: db, TELEGRAM_BOT_TOKEN: 'test', TELEGRAM_WEBHOOK_SECRET: 'secret', ADMIN_TELEGRAM_USER_ID: '1' };
  const calls = [];
  const oldFetch = globalThis.fetch;
  let id = 1000;
  globalThis.fetch = async (url, init) => {
    calls.push({ method: url.split('/').at(-1), ...JSON.parse(init.body) });
    return Response.json({ ok: true, result: { username: 'HomeTestBot', message_id: ++id } });
  };
  const msg = (text) => handleUpdate(env, { update_id: ++id, message: { message_id: id, chat: { id: 1, type: 'private' }, from: { id: 1 }, text } });
  const cb = (data, uid = 1, type = 'private') => handleUpdate(env, { update_id: ++id, callback_query: { id: String(id), from: { id: uid }, data, message: { message_id: 1, chat: { id: uid, type } } } });
  const draft = () => sqlite.prepare('SELECT * FROM poll_drafts').get();
  try {
    await msg('/start');
    assert.equal(calls.at(-1).reply_markup.inline_keyboard[0][0].callback_data, 'admin:newpoll');
    await cb('admin:newpoll', 2);
    assert.equal(draft(), undefined);
    await cb('admin:newpoll', 1, 'supergroup');
    assert.equal(draft(), undefined);
    await cb('admin:newpoll');
    const token = draft().token;
    await cb(`draft:publish:${token}`);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM polls').get().n, 0);
    await msg('Ремонтуємо ліфт?');
    await msg('Так');
    await cb(`draft:preview:${token}`);
    assert.equal(draft().step, 'options');
    await msg('Так');
    assert.equal(JSON.parse(draft().options).length, 1, 'duplicate option rejected');
    await msg('Ні');
    await cb(`draft:preview:${token}`);
    assert.equal(draft().step, 'preview');
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM polls').get().n, 0, 'preview must not publish');
    await cb(`draft:publish:${token}`, 2);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM polls').get().n, 0);
    await cb(`draft:publish:${token}`);
    await cb(`draft:publish:${token}`);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM polls').get().n, 1);
    assert.equal(calls.filter(c => c.method === 'sendMessage' && Number(c.chat_id) === -100123).length, 1);
    assert.equal(draft().step, 'published');
    await cb('admin:newpoll');
    const nextToken = draft().token;
    await cb(`draft:cancel:${token}`);
    assert.equal(draft().token, nextToken, 'old cancel must not delete new draft');
    await cb(`draft:cancel:${nextToken}`);
    assert.equal(draft(), undefined);
    await cb(`draft:publish:${nextToken}`);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM polls').get().n, 1);
    await cb('admin:newpoll');
    await msg('/cancel');
    assert.equal(draft(), undefined);
  } finally { globalThis.fetch = oldFetch; sqlite.close(); }
});

test('multiple groups: connection requests, target selection, scoped registration, disconnect and rejoin', async () => {
  const { handleUpdate } = await import('../src/index.ts');
  const { sqlite, db } = database(false);
  const env = { HOME_DB: db, TELEGRAM_BOT_TOKEN: 'test', TELEGRAM_WEBHOOK_SECRET: 'secret', ADMIN_TELEGRAM_USER_ID: '1' };
  const calls = [];
  const originalFetch = globalThis.fetch;
  let id = 2000;
  globalThis.fetch = async (url, init) => {
    calls.push({ method: url.split('/').at(-1), ...JSON.parse(init.body) });
    return Response.json({ ok: true, result: { username: 'HomeTestBot', message_id: ++id } });
  };
  const group = (chat) => sqlite.prepare('SELECT * FROM groups WHERE chat_id=?').get(chat);
  const msg = (uid, text) => handleUpdate(env, { update_id: ++id, message: { message_id: id, chat: { id: uid, type: 'private' }, from: { id: uid }, text } });
  const cb = (uid, data, message) => handleUpdate(env, { update_id: ++id, callback_query: { id: String(id), from: { id: uid }, data,
    message: message || { message_id: 1, chat: { id: uid, type: 'private' } } } });
  async function membership(chat, oldStatus, status, type = 'supergroup') {
    const update = { update_id: ++id, my_chat_member: { chat: { id: chat, title: `House ${chat}`, type }, from: { id: 6 }, old_chat_member: { status: oldStatus }, new_chat_member: { status } } };
    await handleUpdate(env, update); return update;
  }
  async function register(uid, pollId, approve = true) {
    await msg(uid, `/start poll_${pollId}`); await msg(uid, `Person ${uid}`); await msg(uid, '7');
    const session = sqlite.prepare('SELECT * FROM sessions WHERE user_id=?').get(uid);
    await cb(uid, `role:owner:${session.token}`);
    if (approve) {
      const r = sqlite.prepare('SELECT * FROM residents WHERE user_id=? AND chat_id=?').get(uid, session.chat_id);
      await cb(1, `approve:${uid}:${r.chat_id}:${r.application_token}`);
    }
    return session;
  }
  const voteMessage = p => ({ message_id: p.message_id, chat: { id: p.chat_id, type: 'supergroup' } });
  try {
    await membership(-100111, 'left', 'member');
    const firstRequest = group(-100111).version;
    assert.equal(group(-100111).status, 'pending');
    assert.equal(calls.filter(c => c.method === 'sendMessage').every(c => String(c.chat_id) === '1'), true, 'connection request is private');
    await cb(2, `group:approve:-100111:${firstRequest}`);
    assert.equal(group(-100111).status, 'pending');
    await cb(1, `group:approve:-100111:${firstRequest}`);
    await membership(-100222, 'left', 'administrator');
    await cb(1, `group:approve:-100222:${group(-100222).version}`);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM groups WHERE status='approved'").get().n, 2);
    await membership(-100999, 'left', 'administrator', 'channel');
    assert.equal(group(-100999), undefined, 'channels are not registered as residential groups');
    await cb(1, 'admin:newpoll');
    const draft = sqlite.prepare('SELECT * FROM poll_drafts').get();
    assert.equal(draft.chat_id, null);
    await msg(1, 'Not a question until a group is selected');
    assert.equal(sqlite.prepare('SELECT question FROM poll_drafts').get().question, null);
    await cb(1, `draft:group:${draft.token}:-100222:${group(-100222).version}`);
    await msg(1, 'Question for second house'); await msg(1, 'Yes'); await msg(1, 'No');
    await cb(1, `draft:preview:${draft.token}`);
    assert.match(calls.at(-1).text, /House -100222/);
    await cb(1, `draft:publish:${draft.token}`);
    const p2 = sqlite.prepare('SELECT * FROM polls').get();
    assert.equal(p2.chat_id, -100222);
    assert.equal(calls.filter(c => c.method === 'sendMessage' && c.chat_id === -100111).length, 0);
    // Build another poll through the same real wizard, now for the first house.
    await cb(1, 'admin:newpoll');
    const d1 = sqlite.prepare('SELECT * FROM poll_drafts').get();
    await cb(1, `draft:group:${d1.token}:-100111:${group(-100111).version}`);
    await msg(1, 'Question for first house'); await msg(1, 'Yes'); await msg(1, 'No');
    await cb(1, `draft:preview:${d1.token}`); await cb(1, `draft:publish:${d1.token}`);
    const p1 = sqlite.prepare('SELECT * FROM polls WHERE chat_id=-100111').get();
    await register(2, p1.id);
    await cb(2, `vote:${p2.id}:0`, voteMessage(p2));
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM votes').get().n, 0, 'approval in first house gives no vote in second');
    await cb(2, `vote:${p1.id}:0`, voteMessage(p1));
    await register(2, p2.id);
    await cb(2, `vote:${p2.id}:1`, voteMessage(p2));
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM residents WHERE user_id=2').get().n, 2);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM votes').get().n, 2, 'same apartment number votes independently in each group');
    // An old role button cannot submit an in-progress application for a different house.
    await msg(3, `/start poll_${p1.id}`); await msg(3, 'Third Person'); await msg(3, '8');
    const oldToken = sqlite.prepare('SELECT token FROM sessions WHERE user_id=3').get().token;
    await msg(3, `/start poll_${p2.id}`); await msg(3, 'Third Person'); await msg(3, '9');
    await cb(3, `role:owner:${oldToken}`);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM residents WHERE user_id=3').get().n, 0);
    // Disconnect closes just this group's polls and disables their old vote buttons.
    const connectedVersion = group(-100111).version;
    await cb(1, `group:askdisconnect:-100111:${connectedVersion}`);
    assert.equal(group(-100111).status, 'approved', 'first button only asks for confirmation');
    await cb(1, `group:disconnect:-100111:${connectedVersion}`);
    assert.equal(group(-100111).status, 'disconnected');
    assert.equal(group(-100222).status, 'approved');
    assert.equal(sqlite.prepare('SELECT status FROM polls WHERE id=?').get(p1.id).status, 'closed');
    assert.equal(sqlite.prepare('SELECT status FROM polls WHERE id=?').get(p2.id).status, 'open');
    await cb(2, `vote:${p1.id}:1`, voteMessage(p1));
    assert.equal(sqlite.prepare('SELECT option_index FROM votes WHERE poll_id=?').get(p1.id).option_index, 0);
    await cb(1, `group:approve:-100111:${firstRequest}`);
    assert.equal(group(-100111).status, 'disconnected', 'stale approval cannot reconnect');
    await cb(1, `group:approve:-100111:${group(-100111).version}`);
    assert.equal(group(-100111).status, 'approved');
    assert.equal(sqlite.prepare('SELECT status FROM polls WHERE id=?').get(p1.id).status, 'closed', 'reconnect does not reopen old polls');
    await membership(-100222, 'administrator', 'kicked');
    assert.equal(group(-100222).status, 'removed');
    assert.equal(sqlite.prepare('SELECT status FROM polls WHERE id=?').get(p2.id).status, 'closed');
    const rejoin = await membership(-100222, 'kicked', 'member');
    assert.equal(group(-100222).status, 'pending');
    await handleUpdate(env, rejoin);
    assert.equal(group(-100222).status, 'pending');
    await cb(1, `group:approve:-100222:${group(-100222).version}`);
    assert.equal(group(-100222).status, 'approved');
  } finally { globalThis.fetch = originalFetch; sqlite.close(); }
});

test('multi-group migration preserves old residents, votes and history without enabling a group', () => {
  const sqlite = new DatabaseSync(':memory:');
  try {
    for (const file of ['0001_homebot.sql', '0002_poll_drafts.sql']) sqlite.exec(readFileSync(new URL(`../migrations/${file}`, import.meta.url), 'utf8'));
    sqlite.exec(`INSERT INTO residents(user_id,name,apartment,role,status) VALUES (2,'Existing resident','12','owner','approved');
      INSERT INTO polls(source_update_id,question,options,chat_id,status,created_by) VALUES (1,'Existing poll','["Yes","No"]',-100777,'open',1);
      INSERT INTO votes(poll_id,apartment,user_id,option_index) VALUES (1,'12',2,1);`);
    sqlite.exec(readFileSync(new URL('../migrations/0003_multiple_groups.sql', import.meta.url), 'utf8'));
    const resident = sqlite.prepare('SELECT * FROM residents').get();
    assert.equal(resident.chat_id, -100777);
    assert.equal(resident.status, 'approved');
    assert.equal(resident.application_token.length, 8);
    assert.equal(sqlite.prepare('SELECT option_index FROM votes').get().option_index, 1);
    assert.equal(sqlite.prepare('SELECT status FROM polls').get().status, 'closed');
    assert.equal(sqlite.prepare('SELECT status FROM groups').get().status, 'disconnected');
    assert.equal(sqlite.prepare('PRAGMA foreign_key_check').all().length, 0);
  } finally { sqlite.close(); }
});

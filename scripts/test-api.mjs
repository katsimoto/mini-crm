// Run against an isolated Supabase. --demo uses the three delivery accounts.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const url = process.env.VITE_SUPABASE_URL;
const key = process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
if (!url || !key) throw new Error('Нужны URL и публичный ключ тестового проекта.');
function isPublicKey(value) {
  if (value.startsWith('sb_publishable_')) return true;
  try { return JSON.parse(Buffer.from(value.split('.')[1], 'base64url')).role === 'anon'; }
  catch { return false; }
}
if (!isPublicKey(key)) throw new Error('Разрешён только publishable/anon key.');
const endpoint = new URL(url);
if (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname))) {
  throw new Error('Для удалённого проекта требуется HTTPS.');
}
const clients = [];
const makeClient = () => createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false,
  detectSessionInUrl: false, storageKey: randomUUID() } });
async function ok(request) {
  const { data, error } = await request;
  if (error) throw new Error('Запрос отклонён: ' + (error.code || error.name || 'network'));
  return data;
}
async function denied(request, expectedCode = '42501') {
  const { error } = await request;
  assert.equal(error?.code, expectedCode, 'Ожидался отказ базы ' + expectedCode);
}
async function login(label) {
  const email = process.env['CRM_' + label + '_EMAIL'];
  const password = process.env['CRM_' + label + '_PASSWORD'];
  if (!email || !password) throw new Error('Не задана учётная запись ' + label);
  const client = makeClient();
  const { user } = await ok(client.auth.signInWithPassword({ email, password }));
  clients.push(client);
  return { client, uid: user.id };
}

const demo = process.argv.includes('--demo');
const labels = demo ? ['M1','M1','E1','E2'] : ['M1','M2','E1','E2','U'];
const actors = await Promise.all(labels.map(login));
const [m, m2, e, e2, u] = actors;
assert.equal(new Set(actors.map(actor => actor.uid)).size, demo ? 3 : 5);
if (demo) console.log('DEMO: 3 аккаунта, 2 сессии одного постановщика. Проверка пользователя без профиля пропущена.');
const anon = makeClient();
const rpc = (actor, name, args) => actor.client.rpc(name, args).retry(false);
const read = (actor, table, field, id) => ok(actor.client.from(table).select('*').eq(field, id).order('id'));
const history = (actor, id) => read(actor, 'task_status_history', 'task_id', id);
const step = (actor, id, from, to, comment = null) => rpc(actor, 'transition_task', {
  p_task_id: id, p_expected_status: from, p_to_status: to, p_comment: comment,
});
const sites = [], tasks = [];
async function site() {
  const id = await ok(rpc(m, 'create_object', { p_name: 'Проверка API ' + randomUUID(), p_address: 'Тестовый адрес' }));
  sites.push(id);
  return id;
}
function fields(object, assignee) {
  return { p_object_id: object, p_assignee_id: assignee, p_title: 'Проверочная задача', p_description: '' };
}
async function task(object, assignee) {
  const id = await ok(rpc(m, 'create_task', fields(object, assignee)));
  tasks.push(id);
  return id;
}
async function race(a, b, expectedErrors = ['PT409']) {
  const results = await Promise.all([a, b]);
  assert.equal(results.filter(x => !x.error).length, 1, 'Из двух запросов должен пройти один');
  const rejected = results.find(x => x.error);
  assert.ok(expectedErrors.includes(rejected.error.code), 'Неожиданный отказ в гонке: HTTP ' + rejected.status + ', код ' + rejected.error.code);
  if (rejected.error.code === 'PT409') assert.equal(rejected.status, 409);
  return !results[0].error;
}

try {
  for (const [actor, role] of [[m,'manager'],[m2,'manager'],[e,'executor'],[e2,'executor']]) {
    assert.equal((await read(actor, 'profiles', 'id', actor.uid))[0]?.role, role);
  }
  const shared = await site();
  const own = await task(shared, e.uid);
  const other = await task(shared, e2.uid);
  for (const [actor, allowed, forbidden] of [[e,own,other],[e2,other,own]]) {
    const embedded = await ok(actor.client.from('objects').select('id,tasks(id,task_status_history(id))').eq('id', shared).single());
    assert.deepEqual(embedded.tasks.map(t => t.id), [allowed]);
    assert.deepEqual(await read(actor, 'tasks', 'id', forbidden), []);
    assert.deepEqual(await history(actor, forbidden), []);
    const count = await actor.client.from('tasks').select('id', { count: 'exact', head: true }).eq('object_id', shared);
    assert.equal(count.count, 1);
  }
  if (u) {
    assert.deepEqual(await read(u, 'profiles', 'id', u.uid), []);
    assert.deepEqual(await read(u, 'tasks', 'id', own), []);
    await denied(rpc(u, 'create_object', { p_name: 'Запрет', p_address: 'Тест' }));
  }
  await denied(anon.from('tasks').select('id'));
  await denied(anon.rpc('create_object', { p_name: 'Запрет', p_address: 'Тест' }));
  const invalid = await fetch(url + '/rest/v1/tasks?select=id', { headers: { apikey: key, Authorization: 'Bearer invalid' } });
  assert.equal(invalid.status, 401);
  const internal = await m.client.schema('private').rpc('request_role');
  assert.equal(internal.error?.code, 'PGRST106');
  assert.deepEqual(await read(m2, 'tasks', 'id', own), await read(m, 'tasks', 'id', own));
  console.log('PASS Auth, RLS общего объекта, вложенные задачи, counts, история, anon, JWT, private');

  const original = (await read(m, 'tasks', 'id', own))[0];
  const initial = await history(m, own);
  assert.equal(original.created_by, m.uid);
  assert.equal(original.status, 'new');
  assert.equal(initial.length, 1);
  assert.equal(initial[0].from_status, null);
  assert.equal(initial[0].actor_id, m.uid);
  const previousRole = (await ok(e.client.auth.getUser())).user.user_metadata.role;
  try {
    await ok(e.client.auth.updateUser({ data: {role: 'manager'} }));
    await ok(e.client.auth.refreshSession());
    await denied(rpc(e, 'create_task', fields(shared, e.uid)));
  } finally {
    await ok(e.client.auth.updateUser({ data: {role: previousRole ?? null} }));
  }
  for (const actor of [e, m]) {
    await denied(actor.client.from('profiles').update({role: 'manager'}).eq('id', e.uid));
    await denied(actor.client.from('tasks').update({status: 'accepted'}).eq('id', own));
    await denied(actor.client.from('task_status_history').insert({task_id: own, actor_id: actor.uid, actor_name: 'Подмена', to_status:'new'}));
    await denied(actor.client.from('task_status_history').update({comment:'Подмена'}).eq('task_id', own));
    await denied(actor.client.from('task_status_history').delete().eq('task_id', own));
  }
  await denied(step(e2, own, 'new', 'in_progress'));
  await denied(step(m, own, 'new', 'in_progress'), '22023');
  await denied(step(e, own, 'new', 'accepted'), '22023');
  assert.deepEqual((await read(m, 'tasks', 'id', own))[0], original);
  assert.deepEqual(await history(m, own), initial);
  console.log('PASS запреты подмены роли, полей, перехода и истории; строки после отказов сверены');

  await race(step(e, own, 'new', 'in_progress'), step(e, own, 'new', 'in_progress'));
  assert.equal((await history(m, own)).length, 2);
  await ok(step(e, own, 'in_progress', 'in_review'));
  await denied(step(m2, own, 'in_review', 'rework', ' \t\n'), '22023');
  await ok(step(m2, own, 'in_review', 'rework', 'Проверить размер'));
  await ok(step(e, own, 'rework', 'in_progress'));
  await ok(step(e, own, 'in_progress', 'in_review'));
  const accepted = await race(step(m, own, 'in_review', 'accepted'), step(m2, own, 'in_review', 'rework', 'Исправить'));
  const final = accepted ? 'accepted' : 'rework';
  const events = await history(m, own);
  assert.equal(events.length, 7);
  assert.equal(events.at(-1).to_status, final);
  assert.equal(events.at(-1).actor_id, accepted ? m.uid : m2.uid);
  assert.equal(events[3].comment, 'Проверить размер');
  assert.equal((await read(m, 'tasks', 'id', own))[0].status, final);
  if (!accepted) {
    await ok(step(e, own, 'rework', 'in_progress'));
    await ok(step(e, own, 'in_progress', 'in_review'));
    await ok(step(m2, own, 'in_review', 'accepted'));
  }
  await denied(step(m, own, 'accepted', 'in_progress'), '22023');
  await denied(rpc(m, 'archive_object', { p_object_id: shared }), '22023');
  const beforeMove = await history(m, own);
  await ok(rpc(m2, 'update_task', { ...fields(shared, e2.uid), p_task_id: own }));
  assert.deepEqual(await read(e, 'tasks', 'id', own), []);
  assert.deepEqual(await history(e, own), []);
  assert.deepEqual(await read(e, 'objects', 'id', shared), []);
  assert.deepEqual(await history(e2, own), beforeMove);
  assert.equal((await read(e2, 'tasks', 'id', own))[0].status, 'accepted');
  console.log('PASS весь цикл, переназначение принятой задачи, C01/C02 с одним событием');

  const matrixTask = await task(shared, e.uid);
  const statuses = ['new','in_progress','in_review','rework','accepted'];
  const legal = {
    new: ['in_progress'], in_progress: ['in_review'], in_review: ['accepted','rework'],
    rework: ['in_progress'], accepted: [],
  };
  for (const from of statuses) {
    const before = await read(m, 'tasks', 'id', matrixTask);
    const past = await history(m, matrixTask);
    assert.equal(before[0].status, from);
    for (const actor of [m, e, e2]) {
      for (const to of statuses) {
        if (actor === (from === 'in_review' ? m : e) && legal[from].includes(to)) continue;
        await denied(step(actor, matrixTask, from, to, 'Проверка'), actor === e2 ? '42501' : '22023');
      }
    }
    assert.deepEqual(await read(m, 'tasks', 'id', matrixTask), before);
    assert.deepEqual(await history(m, matrixTask), past);
    for (const assignee of [e2, e]) {
      await ok(rpc(m2, 'update_task', { ...fields(shared, assignee.uid), p_task_id: matrixTask }));
      const previous = assignee === e ? e2 : e;
      assert.deepEqual(await history(previous, matrixTask), []);
      assert.deepEqual(await history(assignee, matrixTask), past);
      assert.equal((await read(assignee, 'tasks', 'id', matrixTask))[0].status, from);
    }
    if (from === 'new' || from === 'rework') await ok(step(e, matrixTask, from, 'in_progress'));
    if (from === 'in_progress' || from === 'rework') await ok(step(e, matrixTask, 'in_progress', 'in_review'));
    if (from === 'in_review') await ok(step(m2, matrixTask, from, 'rework', 'Уточнить размер'));
    if (from === 'rework') await ok(step(m2, matrixTask, 'in_review', 'accepted'));
  }
  console.log('PASS REST: запрещённые пары роль/статус, передача истории во всех пяти статусах');

  const concurrent = await task(shared, e.uid);
  const [move, start] = await Promise.all([
    rpc(m2, 'update_task', { ...fields(shared, e2.uid), p_task_id: concurrent }),
    step(e, concurrent, 'new', 'in_progress'),
  ]);
  assert.ok(!move.error);
  if (start.error) assert.equal(start.error.code, '42501');
  assert.equal((await history(m, concurrent)).length, start.error ? 1 : 2);
  assert.deepEqual(await read(e, 'tasks', 'id', concurrent), []);
  const empty = await site();
  const archived = await race(rpc(m, 'archive_object', { p_object_id: empty }),
    rpc(m2, 'update_task', { ...fields(empty, e2.uid), p_task_id: concurrent }), ['22023', 'P0002']);
  assert.equal(Boolean((await read(m, 'objects', 'id', empty))[0].deleted_at), archived);
  assert.equal((await read(m, 'tasks', 'id', concurrent))[0].object_id, archived ? shared : empty);
  const [removed, advanced] = await Promise.all([
    rpc(m, 'archive_task', { p_task_id: other }), step(e2, other, 'new', 'in_progress'),
  ]);
  assert.ok(!removed.error);
  if (advanced.error) assert.equal(advanced.error.code, '42501');
  assert.ok((await read(m, 'tasks', 'id', other))[0].deleted_at);
  assert.equal((await history(m, other)).length, advanced.error ? 1 : 2);
  await denied(step(e2, other, 'new', 'in_progress'));
  assert.deepEqual(await history(e2, other), []);
  console.log('PASS C03–C05 гонки переназначения, переноса и удаления; состояние сверено');

  const signup = await anon.auth.signUp({ email: 'signup-' + randomUUID() + '@example.org', password: randomBytes(24).toString('base64url') });
  assert.equal(signup.error?.code, 'signup_disabled');
  console.log('PASS H01 прямая регистрация закрыта');
} finally {
  // Existing demo records are never modified. Keep history for archived test fixtures.
  for (const [table, ids, command, param] of [
    ['tasks', tasks, 'archive_task', 'p_task_id'], ['objects', sites, 'archive_object', 'p_object_id'],
  ]) {
    for (const id of ids) {
      if (!(await read(m, table, 'id', id))[0].deleted_at) await ok(rpc(m, command, { [param]: id }));
    }
  }
  await Promise.all(clients.map(client => client.auth.signOut({ scope: 'local' })));
}

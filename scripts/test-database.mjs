/**
 * Runs the real application migration on embedded PostgreSQL (PGlite).
 * Only the Supabase Auth infrastructure is modeled. This does NOT test hosted
 * Auth, PostgREST, exposed-schema settings, or concurrent server connections.
 */
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const db = new PGlite();
const users = {
  manager: '00000000-0000-4000-8000-000000000001',
  manager2: '00000000-0000-4000-8000-000000000002',
  alice: '00000000-0000-4000-8000-000000000003',
  bob: '00000000-0000-4000-8000-000000000004',
  unprovisioned: '00000000-0000-4000-8000-000000000005',
};
const statuses = ['new', 'in_progress', 'in_review', 'accepted', 'rework'];
let checks = 0;

async function asUser(id, work, role = 'authenticated') {
  assert.ok(['authenticated', 'anon'].includes(role));
  await db.exec('begin');
  try {
    await db.query("select set_config('request.jwt.claim.sub', $1, true)", [id ?? '']);
    await db.exec(`set local role ${role}`); // role comes only from the allowlist above.
    const result = await work();
    await db.exec('commit');
    return result;
  } catch (error) {
    await db.exec('rollback');
    throw error;
  }
}

async function denied(work, expectedCodes = []) {
  let thrown;
  try { await work(); } catch (error) { thrown = error; }
  assert.ok(thrown, 'operation unexpectedly succeeded');
  if (expectedCodes.length) {
    assert.ok(expectedCodes.includes(thrown.code), `unexpected SQLSTATE ${thrown.code}: ${thrown.message}`);
  }
}

async function test(name, work) {
  await work();
  checks += 1;
  console.log(`PASS ${name}`);
}

const one = async (sql, args = []) => (await db.query(sql, args)).rows[0];
const createObject = async (actor = users.manager, name = 'Тестовая стройка') =>
  (await asUser(actor, () => one('select public.create_object($1, $2) as id', [name, 'Алматы, тестовый адрес']))).id;
const createTask = async (objectId, assignee = users.alice, actor = users.manager) =>
  (await asUser(actor, () => one('select public.create_task($1, $2, $3, $4) as id', ['Проверить монтаж', '', objectId, assignee]))).id;
const transition = (actor, id, from, to, comment = null, revision) => asUser(actor, async () => {
  const task = await one('select status_revision from public.tasks where id=$1', [id]);
  const expected = revision === undefined ? task?.status_revision ?? null : revision;
  return one('select public.transition_task($1,$2,$3,$4,$5) as id', [id, from, expected, to, comment]);
});
const taskSnapshot = (id) => one(`select t.*, (select count(*)::int from public.task_status_history h where h.task_id=t.id) as events
  from public.tasks t where t.id=$1`, [id]);

async function inStatus(objectId, status, assignee = users.alice) {
  const id = await createTask(objectId, assignee);
  if (status === 'new') return id;
  await transition(assignee, id, 'new', 'in_progress');
  if (status === 'in_progress') return id;
  await transition(assignee, id, 'in_progress', 'in_review');
  if (status === 'in_review') return id;
  await transition(users.manager, id, 'in_review', status, status === 'rework' ? 'Уточнить размеры' : null);
  return id;
}

try {
  // Faithful permission context, deliberately NOT a replacement for hosted Auth.
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin bypassrls;
    create schema auth;
    create table auth.users(id uuid primary key, email text, raw_user_meta_data jsonb default '{}');
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth, public to anon, authenticated;
    grant execute on function auth.uid() to anon, authenticated;
    -- Model permissive defaults so explicit REVOKEs in the migration are tested.
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
    alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
  `);
  const directory = new URL('../supabase/migrations/', import.meta.url);
  for (const filename of (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort()) {
    await db.exec(await readFile(new URL(filename, directory), 'utf8'));
  }
  for (const [name, id] of Object.entries(users)) {
    await db.query('insert into auth.users(id,email) values($1,$2)', [id, `${name}@example.invalid`]);
    if (name !== 'unprovisioned') {
      await db.query('insert into public.profiles(id,display_name,role) values($1,$2,$3)',
        [id, name, name.startsWith('manager') ? 'manager' : 'executor']);
    }
  }

  const sharedObject = await createObject();
  const aliceObject = await createObject(users.manager2, 'Только Алиса');
  const bobObject = await createObject(users.manager, 'Только Борис');
  const aliceShared = await createTask(sharedObject, users.alice);
  const bobShared = await createTask(sharedObject, users.bob);
  const aliceOwn = await createTask(aliceObject, users.alice);
  const bobOwn = await createTask(bobObject, users.bob);

  await test('RLS: shared object does not reveal another executor task or history', async () => {
    for (const [actor, expectedTasks, expectedObjects] of [
      [users.alice, [aliceShared, aliceOwn], [sharedObject, aliceObject]],
      [users.bob, [bobShared, bobOwn], [sharedObject, bobObject]],
    ]) {
      await asUser(actor, async () => {
        assert.deepEqual((await db.query('select id from public.tasks order by id')).rows.map((r) => r.id), expectedTasks.sort());
        assert.deepEqual((await db.query('select id from public.objects order by id')).rows.map((r) => r.id), expectedObjects.sort());
        assert.deepEqual((await db.query('select distinct task_id from public.task_status_history order by task_id')).rows.map((r) => r.task_id), expectedTasks.sort());
        assert.deepEqual((await db.query('select id from public.profiles')).rows.map((r) => r.id), [actor]);
        // The object-to-task join still observes task RLS.
        assert.equal((await one('select count(*)::int as n from public.objects o join public.tasks t on t.object_id=o.id where o.id=$1', [sharedObject])).n, 1);
      });
    }
    for (const manager of [users.manager, users.manager2]) {
      await asUser(manager, async () => {
        assert.equal((await one('select count(*)::int as n from public.tasks')).n, 4);
        assert.equal((await one('select count(*)::int as n from public.profiles')).n, 4);
      });
    }
  });

  await test('anonymous and unprovisioned users cannot access business data or mutate it', async () => {
    await denied(() => asUser(null, () => db.query('select * from public.tasks'), 'anon'), ['42501']);
    await denied(() => asUser(null, () => db.query("select public.create_object('x','y')"), 'anon'), ['42501']);
    await denied(() => asUser(null, () => db.query("select public.create_object('x','y')")), ['42501']);
    await asUser(users.unprovisioned, async () => {
      for (const table of ['profiles', 'objects', 'tasks', 'task_status_history']) {
        assert.equal((await one(`select count(*)::int as n from public.${table}`)).n, 0);
      }
    });
    await denied(() => createObject(users.unprovisioned), ['42501']);
    await denied(() => transition(users.unprovisioned, aliceOwn, 'new', 'in_progress'), ['42501']);
  });

  await test('direct task/profile/history writes denied even for a manager; metadata cannot promote a user', async () => {
    const directWrites = [
      ['update public.tasks set title=$1 where id=$2', ['Подмена', aliceOwn]],
      ["update public.tasks set status='accepted' where id=$1", [aliceOwn]],
      ['update public.tasks set assignee_id=$1,created_by=$1 where id=$2', [users.bob, aliceOwn]],
      ['delete from public.tasks where id=$1', [aliceOwn]],
      ["update public.profiles set role='manager' where id=$1", [users.alice]],
      ['delete from public.profiles where id=$1', [users.alice]],
      ["insert into public.objects(name,address) values('fake','fake')", []],
      ['update public.task_status_history set actor_id=$1,changed_at=now() where task_id=$2', [users.bob, aliceOwn]],
      ['delete from public.task_status_history where task_id=$1', [aliceOwn]],
      ["insert into public.task_status_history(task_id,actor_id,actor_name,from_status,to_status) values($1,$2,'fake','new','in_progress')", [aliceOwn, users.manager]],
    ];
    const before = await taskSnapshot(aliceOwn);
    for (const actor of [users.alice, users.manager]) {
      for (const [sql, args] of directWrites) await denied(() => asUser(actor, () => db.query(sql, args)), ['42501']);
    }
    await db.query("update auth.users set raw_user_meta_data='{" + '"role":"manager"' + "}' where id=$1", [users.alice]);
    await denied(() => createObject(users.alice), ['42501']);
    assert.deepEqual(await taskSnapshot(aliceOwn), before);
  });

  await test('creation stamps server author/time/new status and one initial history event', async () => {
    const id = await createTask(sharedObject, users.bob, users.manager2);
    const task = await taskSnapshot(id);
    const event = await one('select * from public.task_status_history where task_id=$1', [id]);
    assert.equal(task.status, 'new');
    assert.equal(task.created_by, users.manager2);
    assert.equal(task.events, 1);
    assert.equal(event.actor_id, users.manager2);
    assert.equal(event.actor_name, 'manager2');
    assert.equal(event.from_status, null);
    assert.equal(event.to_status, 'new');
    assert.deepEqual(event.changed_at, task.created_at);
    await denied(() => createTask(sharedObject, users.manager), ['22023']);
    await denied(() => createTask(sharedObject, null), ['22023']);
    await denied(() => createTask(sharedObject, users.alice, users.alice), ['42501']);
  });

  await test('complete transition matrix: all 25 pairs for manager, assignee and another executor (75 cases)', async () => {
    for (const [actor, role] of [[users.manager, 'manager'], [users.alice, 'owner'], [users.bob, 'other']]) {
      for (const from of statuses) for (const to of statuses) {
        const id = await inStatus(sharedObject, from);
        const before = await taskSnapshot(id);
        const allowed = role === 'manager'
          ? from === 'in_review' && ['accepted', 'rework'].includes(to)
          : role === 'owner' && ((['new', 'rework'].includes(from) && to === 'in_progress') || (from === 'in_progress' && to === 'in_review'));
        if (allowed) {
          await transition(actor, id, from, to, 'Комментарий для проверки');
          const after = await taskSnapshot(id);
          const event = await one('select * from public.task_status_history where task_id=$1 order by id desc limit 1', [id]);
          assert.equal(after.status, to);
          assert.equal(after.events, before.events + 1);
          assert.equal(event.actor_id, actor);
          assert.equal(event.from_status, from);
          assert.equal(event.to_status, to);
          assert.deepEqual(event.changed_at, after.updated_at);
        } else {
          await denied(() => transition(actor, id, from, to, 'Комментарий'), ['22023', '42501']);
          assert.deepEqual(await taskSnapshot(id), before, `${role}: ${from} -> ${to} changed data`);
        }
      }
    }
  });

  await test('comment, NULL and stale-state checks preserve task/history on failure', async () => {
    const id = await inStatus(sharedObject, 'in_review');
    const before = await taskSnapshot(id);
    for (const comment of [null, '', '   ', '\t\n\r', '\u00a0\u2009\u3000', 'x'.repeat(2001)]) {
      await denied(() => transition(users.manager, id, 'in_review', 'rework', comment), ['22023']);
      assert.deepEqual(await taskSnapshot(id), before);
    }
    await denied(() => transition(users.manager, id, null, 'accepted'), ['PT409']);
    await denied(() => transition(users.manager, id, 'in_review', null), ['22023']);
    await denied(() => transition(users.manager, id, 'new', 'accepted'), ['PT409']);
    assert.deepEqual(await taskSnapshot(id), before);
    await transition(users.manager, id, 'in_review', 'rework', '  Исправить крепления\n');
    const event = await one('select comment from public.task_status_history where task_id=$1 order by id desc limit 1', [id]);
    assert.equal(event.comment, 'Исправить крепления');
    const after = await taskSnapshot(id);
    await denied(() => transition(users.manager, id, 'in_review', 'rework', 'Повтор'), ['PT409']);
    assert.deepEqual(await taskSnapshot(id), after);
  });

  await test('a decision from the first review cannot accept the second review', async () => {
    const id = await inStatus(sharedObject, 'in_review');
    const first = await taskSnapshot(id);
    await transition(users.manager2, id, 'in_review', 'rework', 'Исправить размер');
    await transition(users.alice, id, 'rework', 'in_progress');
    await transition(users.alice, id, 'in_progress', 'in_review');
    const second = await taskSnapshot(id);
    assert.equal(second.status_revision, first.status_revision + 3);
    for (const stale of [first.status_revision, null]) {
      await denied(() => transition(users.manager, id, 'in_review', 'accepted', null, stale), ['PT409']);
      assert.deepEqual(await taskSnapshot(id), second);
    }
    await transition(users.manager, id, 'in_review', 'accepted', null, second.status_revision);
  });

  await test('reassignment transfers access/history and keeps status, author and creation time', async () => {
    const objectId = await createObject();
    const id = await inStatus(objectId, 'in_progress');
    const before = await taskSnapshot(id);
    const edit = (actor, assignee) => asUser(actor, () => db.query('select public.update_task($1,$2,$3,$4,$5)', [id, 'Другое название', 'Описание', objectId, assignee]));
    await denied(() => edit(users.alice, users.bob), ['42501']);
    await edit(users.manager2, users.bob);
    const after = await taskSnapshot(id);
    assert.equal(after.assignee_id, users.bob);
    assert.equal(after.status, before.status);
    assert.equal(after.events, before.events);
    assert.equal(after.created_by, before.created_by);
    assert.deepEqual(after.created_at, before.created_at);
    for (const [actor, expected] of [[users.alice, 0], [users.bob, 1]]) {
      await asUser(actor, async () => {
        assert.equal((await one('select count(*)::int as n from public.tasks where id=$1', [id])).n, expected);
        assert.equal((await one('select count(*)::int as n from public.objects where id=$1', [objectId])).n, expected);
        assert.equal((await one('select count(*)::int as n from public.task_status_history where task_id=$1', [id])).n, expected ? before.events : 0);
      });
    }
    await denied(() => transition(users.alice, id, 'in_progress', 'in_review'), ['42501']);
    await transition(users.bob, id, 'in_progress', 'in_review');
    await transition(users.manager2, id, 'in_review', 'accepted');
    // Fixed exercise assumption: content/assignee edits are allowed even after acceptance.
    await edit(users.manager, users.alice);
    assert.equal((await taskSnapshot(id)).status, 'accepted');
    await denied(() => transition(users.alice, id, 'accepted', 'in_progress'), ['22023']);
  });

  await test('soft deletion keeps immutable audit, hides executor data, and guards nonempty/archived objects', async () => {
    const objectId = await createObject();
    const id = await inStatus(objectId, 'accepted');
    const before = await taskSnapshot(id);
    await denied(() => asUser(users.manager, () => db.query('select public.archive_object($1)', [objectId])), ['22023']);
    await denied(() => asUser(users.alice, () => db.query('select public.archive_task($1)', [id])), ['42501']);
    await asUser(users.manager2, () => db.query('select public.archive_task($1)', [id]));
    const after = await taskSnapshot(id);
    assert.ok(after.deleted_at);
    assert.equal(after.events, before.events);
    await asUser(users.alice, async () => {
      assert.equal((await one('select count(*)::int as n from public.tasks where id=$1', [id])).n, 0);
      assert.equal((await one('select count(*)::int as n from public.task_status_history where task_id=$1', [id])).n, 0);
      assert.equal((await one('select count(*)::int as n from public.objects where id=$1', [objectId])).n, 0);
    });
    await asUser(users.manager, async () => {
      assert.equal((await one('select count(*)::int as n from public.task_status_history where task_id=$1', [id])).n, before.events);
      await db.query('select public.archive_object($1)', [objectId]);
    });
    await denied(() => createTask(objectId), ['P0002']);
    await denied(() => asUser(users.manager, () => db.query('select public.update_task($1,$2,$3,$4,$5)', [aliceOwn, 'Перенос', '', objectId, users.alice])), ['P0002']);
    await denied(() => transition(users.manager, id, 'accepted', 'rework', 'Нет'), ['42501']);
    // Defense in depth: triggers also reject ordinary UPDATE/DELETE by the owner.
    await denied(() => db.query('update public.task_status_history set actor_name=$1 where task_id=$2', ['Подмена', id]), ['42501']);
    await denied(() => db.query('delete from public.task_status_history where task_id=$1', [id]), ['42501']);
    await denied(() => db.exec('truncate public.task_status_history'), ['42501']);
  });

  await test('history INSERT failure rolls back the status change', async () => {
    const id = await createTask(sharedObject);
    const before = await taskSnapshot(id);
    await db.exec(`
      create function private.test_reject_audit_insert() returns trigger language plpgsql as
      $$ begin raise exception using errcode='23514', message='injected_test_failure'; end $$;
      create trigger test_history_insert_failure before insert on public.task_status_history
      for each row execute function private.test_reject_audit_insert();
    `);
    try {
      await denied(() => transition(users.alice, id, 'new', 'in_progress'), ['23514']);
      assert.deepEqual(await taskSnapshot(id), before);
    } finally {
      await db.exec('drop trigger test_history_insert_failure on public.task_status_history; drop function private.test_reject_audit_insert();');
    }
  });

  await test('privilege metadata: RLS on all app tables, no definer in public, no anonymous RPC execution', async () => {
    const tables = (await db.query("select relname,relrowsecurity from pg_class join pg_namespace n on n.oid=relnamespace where n.nspname='public' and relname in ('profiles','objects','tasks','task_status_history')")).rows;
    assert.equal(tables.length, 4);
    assert.ok(tables.every((r) => r.relrowsecurity));
    const functions = (await db.query("select n.nspname,p.proname,p.prosecdef,p.proconfig,has_function_privilege('anon',p.oid,'EXECUTE') as anon_execute from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','private')")).rows;
    assert.ok(functions.filter((r) => r.nspname === 'public').every((r) => !r.prosecdef));
    assert.ok(functions.every((r) => !r.anon_execute));
    assert.ok(functions.filter((r) => r.prosecdef).every((r) => r.proconfig?.some((v) => v.startsWith('search_path='))));
    await denied(() => asUser(users.alice, () => db.query('select private.executor_name($1)', [users.bob])), ['42501']);
  });

  await test('demo seed produces 3 objects, 6 tasks, 15 events and refuses a second run', async () => {
    const seedDb = new PGlite();
    try {
      await seedDb.exec(`
        create role anon nologin;
        create role authenticated nologin;
        create schema auth;
        create table auth.users(id uuid primary key, email text);
        create function auth.uid() returns uuid language sql stable as
          $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
        grant usage on schema auth, public to anon, authenticated;
        grant execute on function auth.uid() to anon, authenticated;
      `);
      for (const filename of (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort()) {
        await seedDb.exec(await readFile(new URL(filename, directory), 'utf8'));
      }
      for (const [id, email] of [[users.manager, 'manager@example.test'], [users.alice, 'executor1@example.test'], [users.bob, 'executor2@example.test']]) {
        await seedDb.query('insert into auth.users(id,email) values($1,$2)', [id, email]);
      }
      const seedSql = await readFile(new URL('../supabase/seed-demo.sql', import.meta.url), 'utf8');
      await seedDb.exec(seedSql);
      const counts = async () => (await seedDb.query(`select
        (select count(*)::int from public.objects) as objects,
        (select count(*)::int from public.tasks) as tasks,
        (select count(*)::int from public.task_status_history) as events,
        (select count(distinct status)::int from public.tasks) as statuses`)).rows[0];
      const expected = { objects: 3, tasks: 6, events: 15, statuses: 5 };
      assert.deepEqual(await counts(), expected);
      await denied(() => seedDb.exec(seedSql), ['P0001']);
      await seedDb.exec('rollback');
      assert.deepEqual(await counts(), expected);
    } finally {
      await seedDb.close();
    }
  });

  console.log(`\n${checks} database test groups passed; transition matrix covers 75 role/status combinations.`);
  console.log('NOT VERIFIED HERE: hosted Auth/PostgREST, signup settings, API schema exposure, multi-connection concurrency, deployment.');
} finally {
  await db.close();
}

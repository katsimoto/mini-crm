-- Run ONCE in the trusted Supabase SQL Editor, after applying the migration.
-- First create these three email/password users in Supabase Auth and confirm them.
-- Change the email values below to match those users. Passwords never belong here.
-- This script intentionally refuses to seed a database containing objects/tasks.
begin;
do $seed$
declare
  v_manager_email text := 'manager@example.test';
  v_executor1_email text := 'executor1@example.test';
  v_executor2_email text := 'executor2@example.test';
  v_manager uuid; v_executor1 uuid; v_executor2 uuid;
  v_object1 uuid; v_object2 uuid; v_object3 uuid;
  v_task1 uuid; v_task2 uuid; v_task3 uuid; v_task4 uuid; v_task5 uuid; v_task6 uuid;
begin
  if exists (select 1 from public.objects) or exists (select 1 from public.tasks) then
    raise exception 'Demo seed requires empty objects/tasks tables; it never deletes existing data.';
  end if;
  select id into v_manager from auth.users where lower(email) = lower(v_manager_email);
  select id into v_executor1 from auth.users where lower(email) = lower(v_executor1_email);
  select id into v_executor2 from auth.users where lower(email) = lower(v_executor2_email);
  if v_manager is null or v_executor1 is null or v_executor2 is null then
    raise exception 'Create and confirm all three Auth users first, then match the email values in this file.';
  end if;
  if v_manager = v_executor1 or v_manager = v_executor2 or v_executor1 = v_executor2 then
    raise exception 'Demo needs three different Auth users.';
  end if;

  -- Trusted provisioning only. There is no profile/role write API for clients.
  insert into public.profiles(id, display_name, role) values
    (v_manager, 'Руководитель — демо', 'manager'),
    (v_executor1, 'Исполнитель 1 — демо', 'executor'),
    (v_executor2, 'Исполнитель 2 — демо', 'executor')
  on conflict (id) do update set display_name = excluded.display_name, role = excluded.role;

  -- A trusted DB administrator can impersonate the fixture actors for seeding.
  -- End users cannot set verified PostgREST request claims through the Data API.
  perform set_config('request.jwt.claim.sub', v_manager::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_manager, 'role', 'authenticated')::text, true);
  v_object1 := public.create_object('ЖК «Северный»', 'Алматы, тестовый адрес 1');
  v_object2 := public.create_object('Складской комплекс', 'Алматы, тестовый адрес 2');
  v_object3 := public.create_object('Офисное здание', 'Алматы, тестовый адрес 3');
  v_task1 := public.create_task('Проверить опалубку', 'Проверить крепления перед бетонированием.', v_object1, v_executor1);
  v_task2 := public.create_task('Принять бетон', 'Сверить документы и результаты входного контроля.', v_object2, v_executor1);
  v_task3 := public.create_task('Сверить исполнительную схему', 'Сравнить схему с выполненными работами.', v_object1, v_executor2);
  v_task4 := public.create_task('Проверить армирование', 'Осмотреть армирование перед следующим этапом.', v_object3, v_executor2);
  v_task5 := public.create_task('Исправить гидроизоляцию', 'Проверить герметичность стыков.', v_object2, v_executor1);
  v_task6 := public.create_task('Проверить ограждение', 'Проверить временное ограждение строительной площадки.', v_object3, v_executor2);

  perform set_config('request.jwt.claim.sub', v_executor1::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_executor1, 'role', 'authenticated')::text, true);
  perform public.transition_task(v_task2, 'new', 1, 'in_progress');
  perform public.transition_task(v_task5, 'new', 1, 'in_progress');
  perform public.transition_task(v_task5, 'in_progress', 2, 'in_review');

  perform set_config('request.jwt.claim.sub', v_executor2::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_executor2, 'role', 'authenticated')::text, true);
  perform public.transition_task(v_task3, 'new', 1, 'in_progress');
  perform public.transition_task(v_task3, 'in_progress', 2, 'in_review');
  perform public.transition_task(v_task4, 'new', 1, 'in_progress');
  perform public.transition_task(v_task4, 'in_progress', 2, 'in_review');

  perform set_config('request.jwt.claim.sub', v_manager::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_manager, 'role', 'authenticated')::text, true);
  perform public.transition_task(v_task4, 'in_review', 3, 'accepted', 'Проверка завершена, замечаний нет.');
  perform public.transition_task(v_task5, 'in_review', 3, 'rework', 'Повторно обработать стык на северной стороне.');
end $seed$;
commit;

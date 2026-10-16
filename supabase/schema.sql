-- Abendritual: Tabellen für die Liste und die guten Momente.
-- Im Supabase-Dashboard unter "SQL Editor" einfügen und auf "Run" klicken.
-- Kann gefahrlos mehrmals ausgeführt werden.

create table if not exists public.aufgaben (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  text        text not null,
  erledigt    boolean not null default false,
  erledigt_am timestamptz,
  erstellt_am timestamptz not null default now()
);

create table if not exists public.momente (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  datum       date not null,
  text        text not null,
  erstellt_am timestamptz not null default now()
);

create index if not exists aufgaben_user_idx on public.aufgaben (user_id, erstellt_am);
create index if not exists momente_user_idx on public.momente (user_id, datum desc);

-- Jede Person sieht und ändert nur ihre eigenen Zeilen.
alter table public.aufgaben enable row level security;
alter table public.momente enable row level security;

drop policy if exists "eigene aufgaben" on public.aufgaben;
create policy "eigene aufgaben" on public.aufgaben
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists "eigene momente" on public.momente;
create policy "eigene momente" on public.momente
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

grant select, insert, update, delete on public.aufgaben, public.momente to authenticated;

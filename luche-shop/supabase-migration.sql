-- Выполнить один раз в Supabase SQL Editor после первоначальной схемы.
alter table products
  add column if not exists category text,
  add column if not exists attributes jsonb not null default '[]'::jsonb,
  add column if not exists images jsonb not null default '[]'::jsonb;

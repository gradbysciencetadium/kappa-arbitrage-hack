-- Kappa Arbitrage — Supabase schema.
-- Run this in the Supabase SQL editor (Dashboard → SQL → New query → paste → Run).
-- The app works without this (in-memory fallback); run it to persist everything.

create extension if not exists pgcrypto;

create table if not exists conversations (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now()
);

create table if not exists messages (
  id               bigint generated always as identity primary key,
  conversation_id  uuid references conversations(id) on delete cascade,
  role             text not null,            -- 'user' | 'model'
  text             text not null,
  created_at       timestamptz not null default now()
);
create index if not exists messages_conversation_idx on messages(conversation_id, created_at);

create table if not exists briefs (
  conversation_id  uuid primary key references conversations(id) on delete cascade,
  brief            jsonb not null,
  created_at       timestamptz not null default now()
);

create table if not exists reports (
  id               uuid primary key default gen_random_uuid(),
  conversation_id  uuid references conversations(id) on delete set null,
  brief            jsonb,
  status           text not null default 'pending',  -- pending | running | done | failed
  progress         text,
  result           jsonb,
  meta             jsonb,
  error            text,
  created_at       timestamptz not null default now()
);
create index if not exists reports_status_idx on reports(status, created_at);

create table if not exists leads (
  id          uuid primary key default gen_random_uuid(),
  email       text,
  name        text,
  business    text,
  note        text,
  conversation_id uuid,
  created_at  timestamptz not null default now()
);

-- AI Accountability Ledger — append-only, hash-chained audit trail of every analysis.
create table if not exists audit_ledger (
  id          uuid primary key default gen_random_uuid(),
  report_id   uuid,
  prev_hash   text,
  hash        text not null,
  payload     jsonb not null,
  created_at  timestamptz not null default now()
);
create index if not exists audit_ledger_created_idx on audit_ledger(created_at);

-- Realtime: let the frontend subscribe to live report progress.
alter publication supabase_realtime add table reports;

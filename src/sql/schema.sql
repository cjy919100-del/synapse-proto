-- Synapse prototype schema (idempotent).

create table if not exists agents (
  agent_id uuid primary key,
  agent_name text not null,
  public_key text not null,
  created_at timestamptz not null default now()
);

create table if not exists ledger (
  agent_id uuid primary key references agents(agent_id) on delete cascade,
  credits integer not null,
  locked integer not null,
  updated_at timestamptz not null default now()
);

create table if not exists jobs (
  job_id uuid primary key,
  title text not null,
  description text null,
  budget integer not null,
  requester_id uuid not null references agents(agent_id) on delete cascade,
  created_at_ms bigint not null,
  status text not null,
  worker_id uuid null references agents(agent_id) on delete set null,
  kind text not null default 'simple',
  payload jsonb not null default '{}'::jsonb
);

create index if not exists jobs_created_at_ms_idx on jobs(created_at_ms desc);
create index if not exists jobs_status_idx on jobs(status);

create table if not exists bids (
  bid_id uuid primary key,
  job_id uuid not null references jobs(job_id) on delete cascade,
  bidder_id uuid not null references agents(agent_id) on delete cascade,
  price integer not null,
  eta_seconds integer not null,
  created_at_ms bigint not null
);

create index if not exists bids_job_id_idx on bids(job_id);
create index if not exists bids_created_at_ms_idx on bids(created_at_ms desc);

create table if not exists events (
  id bigserial primary key,
  at timestamptz not null default now(),
  kind text not null,
  payload jsonb not null
);

create index if not exists events_at_idx on events(at desc);

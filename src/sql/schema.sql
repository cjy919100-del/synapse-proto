-- Synapse prototype schema (idempotent).

create table if not exists agents (
  agent_id text primary key,
  agent_name text not null,
  public_key text null,
  created_at timestamptz not null default now()
);

do $$
begin
  -- Allow external identities (e.g. GitHub users/repos) that don't have a public key.
  alter table agents alter column public_key drop not null;
exception
  when undefined_table then null;
  when undefined_column then null;
  when others then null;
end $$;

create table if not exists ledger (
  agent_id text primary key references agents(agent_id) on delete cascade,
  credits integer not null,
  locked integer not null,
  updated_at timestamptz not null default now()
);

create table if not exists reputation (
  agent_id text primary key references agents(agent_id) on delete cascade,
  completed integer not null default 0,
  failed integer not null default 0,
  updated_at timestamptz not null default now()
);

create table if not exists job_evidence (
  id bigserial primary key,
  job_id uuid not null references jobs(job_id) on delete cascade,
  kind text not null,
  detail text not null default '',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists job_evidence_job_id_idx on job_evidence(job_id);
create index if not exists job_evidence_created_at_idx on job_evidence(created_at desc);

do $$
begin
  alter table job_evidence add column if not exists detail text not null default '';
exception
  when undefined_table then null;
  when others then null;
end $$;

create table if not exists jobs (
  job_id uuid primary key,
  title text not null,
  description text null,
  budget integer not null,
  requester_id text not null references agents(agent_id) on delete cascade,
  created_at_ms bigint not null,
  status text not null,
  worker_id text null references agents(agent_id) on delete set null,
  kind text not null default 'simple',
  payload jsonb not null default '{}'::jsonb
);

create index if not exists jobs_created_at_ms_idx on jobs(created_at_ms desc);
create index if not exists jobs_status_idx on jobs(status);

create table if not exists bids (
  bid_id uuid primary key,
  job_id uuid not null references jobs(job_id) on delete cascade,
  bidder_id text not null references agents(agent_id) on delete cascade,
  price integer not null,
  eta_seconds integer not null,
  created_at_ms bigint not null,
  pitch text null
);

create index if not exists bids_job_id_idx on bids(job_id);
create index if not exists bids_created_at_ms_idx on bids(created_at_ms desc);

do $$
begin
  alter table bids add column if not exists pitch text null;
exception
  when undefined_table then null;
  when others then null;
end $$;

create table if not exists events (
  id bigserial primary key,
  at timestamptz not null default now(),
  kind text not null,
  payload jsonb not null
);

create index if not exists events_at_idx on events(at desc);

create table if not exists github_issue_jobs (
  owner text not null,
  repo text not null,
  issue_number integer not null,
  job_id uuid not null references jobs(job_id) on delete cascade,
  primary key (owner, repo, issue_number)
);

create table if not exists github_pr_jobs (
  owner text not null,
  repo text not null,
  pr_number integer not null,
  job_id uuid not null references jobs(job_id) on delete cascade,
  head_sha text null,
  author_login text null,
  merged boolean not null default false,
  primary key (owner, repo, pr_number)
);

create index if not exists github_pr_jobs_head_sha_idx on github_pr_jobs(head_sha);

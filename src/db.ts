import pg from 'pg';

import type { Bid, Job } from './protocol.js';
import type { ObserverSnapshot } from './server.js';

const { Pool } = pg;

export type SynapseDbOptions = {
  connectionString: string;
};

export class SynapseDb {
  private readonly pool: pg.Pool;

  constructor(opts: SynapseDbOptions) {
    this.pool = new Pool({ connectionString: opts.connectionString });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async ensureSchema(): Promise<void> {
    // Keep schema string embedded so runtime doesn't depend on copying SQL assets into dist/.
    await this.pool.query(SCHEMA_SQL);
  }

  async upsertAgent(args: { agentId: string; agentName: string; publicKeyDerB64?: string | null }): Promise<void> {
    await this.pool.query(
      `
      insert into agents (agent_id, agent_name, public_key)
      values ($1, $2, $3)
      on conflict (agent_id) do update set
        agent_name = excluded.agent_name,
        public_key = excluded.public_key
      `,
      [args.agentId, args.agentName, args.publicKeyDerB64 ?? null],
    );
  }

  async upsertLedger(args: { agentId: string; credits: number; locked: number }): Promise<void> {
    await this.pool.query(
      `
      insert into ledger (agent_id, credits, locked)
      values ($1, $2, $3)
      on conflict (agent_id) do update set
        credits = excluded.credits,
        locked = excluded.locked,
        updated_at = now()
      `,
      [args.agentId, Math.floor(args.credits), Math.floor(args.locked)],
    );
  }

  async insertJob(job: Job): Promise<void> {
    await this.pool.query(
      `
      insert into jobs (job_id, title, description, budget, requester_id, created_at_ms, status, worker_id, kind, payload)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      on conflict (job_id) do nothing
      `,
      [
        job.id,
        job.title,
        job.description ?? null,
        job.budget,
        job.requesterId,
        job.createdAtMs,
        job.status,
        job.workerId ?? null,
        job.kind ?? 'simple',
        job.payload ?? {},
      ],
    );
  }

  async updateJob(job: Job): Promise<void> {
    await this.pool.query(
      `
      update jobs
      set title = $2,
          description = $3,
          budget = $4,
          requester_id = $5,
          status = $6,
          worker_id = $7,
          kind = $8,
          payload = $9
      where job_id = $1
      `,
      [
        job.id,
        job.title,
        job.description ?? null,
        job.budget,
        job.requesterId,
        job.status,
        job.workerId ?? null,
        job.kind ?? 'simple',
        job.payload ?? {},
      ],
    );
  }

  async insertBid(bid: Bid): Promise<void> {
    await this.pool.query(
      `
      insert into bids (bid_id, job_id, bidder_id, price, eta_seconds, created_at_ms)
      values ($1,$2,$3,$4,$5,$6)
      on conflict (bid_id) do nothing
      `,
      [bid.id, bid.jobId, bid.bidderId, bid.price, bid.etaSeconds, bid.createdAtMs],
    );
  }

  async insertEvent(args: { kind: string; payload: unknown }): Promise<void> {
    await this.pool.query(`insert into events (kind, payload) values ($1, $2)`, [args.kind, args.payload]);
  }

  async upsertGithubIssueJobLink(args: {
    owner: string;
    repo: string;
    issueNumber: number;
    jobId: string;
  }): Promise<void> {
    await this.pool.query(
      `
      insert into github_issue_jobs (owner, repo, issue_number, job_id)
      values ($1, $2, $3, $4)
      on conflict (owner, repo, issue_number) do update set
        job_id = excluded.job_id
      `,
      [args.owner, args.repo, Math.floor(args.issueNumber), args.jobId],
    );
  }

  async getGithubJobIdByIssue(args: { owner: string; repo: string; issueNumber: number }): Promise<string | null> {
    const res = await this.pool.query(
      `
      select job_id
      from github_issue_jobs
      where owner = $1 and repo = $2 and issue_number = $3
      `,
      [args.owner, args.repo, Math.floor(args.issueNumber)],
    );
    if (res.rowCount === 0) return null;
    return String(res.rows[0]!.job_id);
  }

  async upsertGithubPrJobLink(args: {
    owner: string;
    repo: string;
    prNumber: number;
    jobId: string;
    headSha?: string | null;
    authorLogin?: string | null;
    merged?: boolean;
  }): Promise<void> {
    await this.pool.query(
      `
      insert into github_pr_jobs (owner, repo, pr_number, job_id, head_sha, author_login, merged)
      values ($1, $2, $3, $4, $5, $6, $7)
      on conflict (owner, repo, pr_number) do update set
        job_id = excluded.job_id,
        head_sha = coalesce(excluded.head_sha, github_pr_jobs.head_sha),
        author_login = coalesce(excluded.author_login, github_pr_jobs.author_login),
        merged = excluded.merged
      `,
      [
        args.owner,
        args.repo,
        Math.floor(args.prNumber),
        args.jobId,
        args.headSha ?? null,
        args.authorLogin ?? null,
        Boolean(args.merged),
      ],
    );
  }

  async getGithubJobIdByPr(args: { owner: string; repo: string; prNumber: number }): Promise<string | null> {
    const res = await this.pool.query(
      `
      select job_id
      from github_pr_jobs
      where owner = $1 and repo = $2 and pr_number = $3
      `,
      [args.owner, args.repo, Math.floor(args.prNumber)],
    );
    if (res.rowCount === 0) return null;
    return String(res.rows[0]!.job_id);
  }

  async getObserverSnapshot(): Promise<ObserverSnapshot> {
    const agentsRes = await this.pool.query(
      `
      select a.agent_id, a.agent_name, coalesce(l.credits, 0) as credits, coalesce(l.locked, 0) as locked
      from agents a
      left join ledger l on l.agent_id = a.agent_id
      order by l.credits desc nulls last, a.created_at desc
      `,
    );
    const jobsRes = await this.pool.query(
      `
      select job_id, title, description, budget, requester_id, created_at_ms, status, worker_id, kind, payload
      from jobs
      order by created_at_ms desc
      `,
    );
    const bidsRes = await this.pool.query(
      `
      select bid_id, job_id, bidder_id, price, eta_seconds, created_at_ms
      from bids
      order by created_at_ms desc
      `,
    );

    return {
      agents: agentsRes.rows.map((r) => ({
        agentId: String(r.agent_id),
        agentName: String(r.agent_name),
        credits: Number(r.credits),
        locked: Number(r.locked),
      })),
      jobs: jobsRes.rows.map((r) => ({
        id: String(r.job_id),
        title: String(r.title),
        description: r.description == null ? undefined : String(r.description),
        budget: Number(r.budget),
        requesterId: String(r.requester_id),
        createdAtMs: Number(r.created_at_ms),
        status: r.status as Job['status'],
        workerId: r.worker_id == null ? undefined : String(r.worker_id),
        kind: String(r.kind ?? 'simple'),
        payload: (r.payload ?? {}) as Record<string, unknown>,
      })),
      bids: bidsRes.rows.map((r) => ({
        id: String(r.bid_id),
        jobId: String(r.job_id),
        bidderId: String(r.bidder_id),
        price: Number(r.price),
        etaSeconds: Number(r.eta_seconds),
        createdAtMs: Number(r.created_at_ms),
      })),
    };
  }
}

const SCHEMA_SQL = `
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
`;

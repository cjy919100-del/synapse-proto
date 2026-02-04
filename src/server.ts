import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { WebSocketServer } from 'ws';
import type WebSocket from 'ws';
import type { RawData } from 'ws';

import { SynapseDb } from './db.js';
import { randomNonceB64, verifyAuth } from './crypto.js';
import { deriveAgentId } from './identity.js';
import {
  PROTOCOL_VERSION,
  type AgentToServerMsg,
  type AuthedMsg,
  type Bid,
  type BidPostedMsg,
  type ChallengeMsg,
  type ErrorMsg,
  type Job,
  type JobAwardedMsg,
  type JobCompletedMsg,
  type JobPostedMsg,
  type LedgerUpdateMsg,
  type ServerToAgentMsg,
  safeParseAgentMessage,
  type JobFailedMsg,
} from './protocol.js';
import { evaluateSubmission } from './evaluator.js';

type Session = {
  ws: WebSocket;
  challengeNonceB64: string;
  authed: boolean;
  agentId?: string;
  agentName?: string;
  publicKeyDerB64?: string;
};

type LedgerAccount = {
  credits: number;
  locked: number;
};

type JobState = Job & {
  bids: Bid[];
  lockedBudget: number;
};

const DEFAULT_STARTING_CREDITS = 1_000;

type TapeEvent =
  | { type: 'agent_authed'; agentId: string; agentName: string; credits: number }
  | { type: 'ledger_update'; agentId: string; credits: number; locked: number }
  | { type: 'broadcast'; msg: ServerToAgentMsg };

export type ObserverSnapshot = {
  agents: Array<{ agentId: string; agentName: string; credits: number; locked: number }>;
  jobs: Job[];
  bids: Bid[];
};

export class CoreServer extends EventEmitter {
  private readonly wss: WebSocketServer;
  private readonly sessions = new Map<WebSocket, Session>();
  private readonly ledger = new Map<string, LedgerAccount>();
  private readonly jobs = new Map<string, JobState>();
  private readonly db?: SynapseDb;

  constructor(readonly port: number, opts?: { db?: SynapseDb }) {
    super();
    this.db = opts?.db;
    this.wss = new WebSocketServer({ port });
    this.wss.on('connection', (ws: WebSocket) => this.onConnection(ws));
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      this.wss.close(() => resolve());
      for (const ws of this.sessions.keys()) ws.close();
    });
  }

  getListeningPort(): number {
    const addr = this.wss.address();
    if (addr && typeof addr === 'object' && 'port' in addr) return addr.port as number;
    return this.port;
  }

  private onConnection(ws: WebSocket) {
    const nonceB64 = randomNonceB64();
    const session: Session = { ws, challengeNonceB64: nonceB64, authed: false };
    this.sessions.set(ws, session);

    const challenge: ChallengeMsg = {
      v: PROTOCOL_VERSION,
      type: 'challenge',
      nonce: nonceB64,
      serverTimeMs: Date.now(),
    };
    this.send(ws, challenge);

    ws.on('message', (raw: RawData) => void this.onMessage(ws, raw.toString('utf8')));
    ws.on('close', () => this.onClose(ws));
    ws.on('error', () => this.onClose(ws));
  }

  private onClose(ws: WebSocket) {
    const session = this.sessions.get(ws);
    this.sessions.delete(ws);
    if (session?.authed && session.agentId) {
      // Keep ledger entries (simulating persistent wallet), but drop session binding.
      this.log(`[server] disconnected: ${session.agentName ?? session.agentId}`);
    }
  }

  private async onMessage(ws: WebSocket, rawText: string) {
    const session = this.sessions.get(ws);
    if (!session) return;

    const parsed = safeParseAgentMessage(rawText);
    if (!parsed.success) {
      return this.fail(ws, 'invalid_message'); // Zod error handling could be more granular
    }

    const msg = parsed.data;

    // Auth must happen first.
    if (!session.authed && msg.type !== 'auth') {
      return this.fail(ws, 'not_authenticated');
    }

    switch (msg.type) {
      case 'auth':
        return await this.handleAuth(session, msg);
      case 'post_job':
        return await this.handlePostJob(session, msg);
      case 'bid':
        return await this.handleBid(session, msg);
      case 'award':
        return await this.handleAward(session, msg);
      case 'submit':
        return await this.handleSubmit(session, msg);
      // Validated by Zod, but switch might be missing cases in future
      default:
        return this.fail(ws, 'unknown_type');
    }
  }

  private async handleAuth(session: Session, msg: AgentToServerMsg & { type: 'auth' }) {
    if (session.authed) return;
    if (msg.nonce !== session.challengeNonceB64) return this.fail(session.ws, 'bad_nonce');

    // Zod already validated strings, but custom logic check:
    if (msg.agentName.length < 1) {
      return this.fail(session.ws, 'bad_agent_name');
    }

    const ok = verifyAuth({
      nonceB64: msg.nonce,
      agentName: msg.agentName,
      publicKeyDerB64: msg.publicKey,
      signatureB64: msg.signature,
    });
    if (!ok) return this.fail(session.ws, 'signature_verification_failed');

    const agentId = deriveAgentId(msg.publicKey);
    session.authed = true;
    session.agentId = agentId;
    session.agentName = msg.agentName;
    session.publicKeyDerB64 = msg.publicKey;

    if (!this.ledger.has(agentId)) {
      this.ledger.set(agentId, { credits: DEFAULT_STARTING_CREDITS, locked: 0 });
    }
    const current = this.ledger.get(agentId)!;
    const authed: AuthedMsg = {
      v: PROTOCOL_VERSION,
      type: 'authed',
      agentId,
      credits: current.credits,
    };

    // DB mode: persist identity and wallet before acknowledging auth (so observer snapshot can be DB-backed).
    if (this.db) {
      try {
        await this.db.upsertAgent({ agentId, agentName: msg.agentName, publicKeyDerB64: msg.publicKey });
        await this.db.upsertLedger({ agentId, credits: current.credits, locked: current.locked });
      } catch (err) {
        // Keep any existing in-memory account; auth fails but we don't want to corrupt state.
        session.authed = false;
        session.agentId = undefined;
        session.agentName = undefined;
        session.publicKeyDerB64 = undefined;
        this.log(`[server] db_error_auth: ${(err as Error).message}`);
        return this.fail(session.ws, 'db_error_auth');
      }
    }

    this.send(session.ws, authed);
    this.log(`[server] authed: ${msg.agentName} (${agentId.slice(0, 8)})`);

    const evt: TapeEvent = {
      type: 'agent_authed',
      agentId,
      agentName: msg.agentName,
      credits: current.credits,
    };
    this.emit('tape', evt);
    if (this.db) void this.db.insertEvent({ kind: 'agent_authed', payload: evt });
  }

  private async handlePostJob(session: Session, msg: AgentToServerMsg & { type: 'post_job' }) {
    const requesterId = session.agentId!;
    const acct = this.ledger.get(requesterId);
    if (!acct) return this.fail(session.ws, 'no_ledger_account');

    // Zod ensures types, check business rules
    if (acct.credits - acct.locked < msg.budget) return this.fail(session.ws, 'insufficient_credits');

    const jobId = crypto.randomUUID();
    const job: JobState = {
      id: jobId,
      title: msg.title,
      description: msg.description,
      budget: Math.floor(msg.budget),
      requesterId,
      createdAtMs: Date.now(),
      status: 'open',
      bids: [],
      lockedBudget: 0,
      kind: msg.kind || 'simple',
      payload: msg.payload || {},
    };
    this.jobs.set(jobId, job);

    const out: JobPostedMsg = { v: PROTOCOL_VERSION, type: 'job_posted', job };
    this.broadcast(out);

    if (this.db) {
      try {
        await this.db.insertJob(job);
        void this.db.insertEvent({ kind: 'job_posted', payload: out });
      } catch (err) {
        this.log(`[server] db_error_job_posted: ${(err as Error).message}`);
      }
    }
  }

  private async handleBid(session: Session, msg: AgentToServerMsg & { type: 'bid' }) {
    const bidderId = session.agentId!;
    const job = this.jobs.get(msg.jobId);
    if (!job) return this.fail(session.ws, 'job_not_found');
    if (job.status !== 'open') return this.fail(session.ws, 'job_not_open');
    // Zod checked price/eta > 0

    const bid: Bid = {
      id: crypto.randomUUID(),
      jobId: job.id,
      bidderId,
      price: Math.floor(msg.price),
      etaSeconds: Math.floor(msg.etaSeconds),
      createdAtMs: Date.now(),
    };
    job.bids.push(bid);

    const out: BidPostedMsg = { v: PROTOCOL_VERSION, type: 'bid_posted', bid };
    this.broadcast(out);

    if (this.db) {
      try {
        await this.db.insertBid(bid);
        void this.db.insertEvent({ kind: 'bid_posted', payload: out });
      } catch (err) {
        this.log(`[server] db_error_bid_posted: ${(err as Error).message}`);
      }
    }
  }

  private async handleAward(session: Session, msg: AgentToServerMsg & { type: 'award' }) {
    const requesterId = session.agentId!;
    const job = this.jobs.get(msg.jobId);
    if (!job) return this.fail(session.ws, 'job_not_found');
    if (job.requesterId !== requesterId) return this.fail(session.ws, 'not_job_owner');
    if (job.status !== 'open') return this.fail(session.ws, 'job_not_open');

    const workerId = msg.workerId;
    const hasBid = job.bids.some((b) => b.bidderId === workerId);
    if (!hasBid) return this.fail(session.ws, 'worker_has_no_bid');

    const acct = this.ledger.get(requesterId);
    if (!acct) return this.fail(session.ws, 'no_ledger_account');
    if (acct.credits - acct.locked < job.budget) return this.fail(session.ws, 'insufficient_credits');

    acct.locked += job.budget;
    job.lockedBudget = job.budget;
    job.status = 'awarded';
    job.workerId = workerId;

    const out: JobAwardedMsg = {
      v: PROTOCOL_VERSION,
      type: 'job_awarded',
      jobId: job.id,
      workerId,
      budgetLocked: job.budget,
    };
    this.broadcast(out);

    if (this.db) {
      try {
        await this.db.updateJob(job);
        await this.db.upsertLedger({ agentId: requesterId, credits: acct.credits, locked: acct.locked });
        void this.db.insertEvent({ kind: 'job_awarded', payload: out });
      } catch (err) {
        this.log(`[server] db_error_job_awarded: ${(err as Error).message}`);
      }
    }
  }

  private async handleSubmit(session: Session, msg: AgentToServerMsg & { type: 'submit' }) {
    const workerId = session.agentId!;
    const job = this.jobs.get(msg.jobId);
    if (!job) return this.fail(session.ws, 'job_not_found');
    if (job.status !== 'awarded') return this.fail(session.ws, 'job_not_awarded');
    if (job.workerId !== workerId) return this.fail(session.ws, 'not_assigned_worker');

    // Prototype: accept all submissions. Replace with evaluators later.
    // Evaluate submission if it's a coding task
    if (job.kind === 'coding') {
      // payload types are generic in protocol, cast or safely parse
      const evaluation = evaluateSubmission(job.payload || {}, msg.result);
      if (!evaluation.success) {
        job.status = 'failed';
        this.emit('tape', {
          type: 'broadcast',
          msg: {
            v: PROTOCOL_VERSION,
            type: 'job_failed',
            jobId: job.id,
            workerId,
            reason: evaluation.reason,
          },
        });
        // We do NOT pay the worker. Locked budget returns to requester?
        // For simplicity in this iteration:
        // 1. Fail the job (status='failed')
        // 2. Unlock requester funds (refund)
        // 3. Notify failure

        const requesterAcct = this.ledger.get(job.requesterId);
        if (requesterAcct) {
          requesterAcct.locked -= job.lockedBudget;
          // Credits act as if budget was returned to available (since it was locked within the full balance).
          // Actually, locked means "reserved but still in credits". So reducing locked is enough to free it up.
        }

        const failedMsg: JobFailedMsg = {
          v: PROTOCOL_VERSION,
          type: 'job_failed',
          jobId: job.id,
          workerId,
          reason: evaluation.reason,
        };
        this.broadcast(failedMsg);
        this.sendLedgerUpdate(job.requesterId);

        if (this.db) {
          await this.db.updateJob(job);
          if (requesterAcct) {
            await this.db.upsertLedger({
              agentId: job.requesterId,
              credits: requesterAcct.credits,
              locked: requesterAcct.locked,
            });
          }
          await this.db.insertEvent({ kind: 'job_failed', payload: failedMsg });
        }
        return;
      }
    }

    // Pass (or simple task)
    job.status = 'completed';

    const requesterAcct = this.ledger.get(job.requesterId);
    const workerAcct = this.ledger.get(workerId);
    if (!requesterAcct || !workerAcct) return this.fail(session.ws, 'ledger_missing');

    requesterAcct.locked -= job.lockedBudget;
    requesterAcct.credits -= job.lockedBudget;
    workerAcct.credits += job.lockedBudget;

    const completed: JobCompletedMsg = {
      v: PROTOCOL_VERSION,
      type: 'job_completed',
      jobId: job.id,
      workerId,
      paid: job.lockedBudget,
    };
    this.broadcast(completed);

    this.sendLedgerUpdate(job.requesterId);
    this.sendLedgerUpdate(workerId);

    if (this.db) {
      try {
        await this.db.updateJob(job);
        await this.db.upsertLedger({
          agentId: job.requesterId,
          credits: requesterAcct.credits,
          locked: requesterAcct.locked,
        });
        await this.db.upsertLedger({ agentId: workerId, credits: workerAcct.credits, locked: workerAcct.locked });
        void this.db.insertEvent({ kind: 'job_completed', payload: completed });
      } catch (err) {
        this.log(`[server] db_error_job_completed: ${(err as Error).message}`);
      }
    }

    // Keep result for future; currently unused.
    void msg.result;
  }

  private sendLedgerUpdate(agentId: string) {
    const acct = this.ledger.get(agentId);
    if (!acct) return;
    const msg: LedgerUpdateMsg = { v: PROTOCOL_VERSION, type: 'ledger_update', credits: acct.credits };
    for (const session of this.sessions.values()) {
      if (session.authed && session.agentId === agentId) this.send(session.ws, msg);
    }

    const evt: TapeEvent = {
      type: 'ledger_update',
      agentId,
      credits: acct.credits,
      locked: acct.locked,
    };
    this.emit('tape', evt);

    if (this.db) {
      void this.db
        .upsertLedger({ agentId, credits: acct.credits, locked: acct.locked })
        .then(() => this.db!.insertEvent({ kind: 'ledger_update', payload: evt }))
        .catch((err) => this.log(`[server] db_error_ledger_update: ${(err as Error).message}`));
    }
  }

  private send(ws: WebSocket, msg: ServerToAgentMsg) {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify(msg));
  }

  private broadcast(msg: ServerToAgentMsg) {
    const text = JSON.stringify(msg);
    for (const session of this.sessions.values()) {
      if (session.ws.readyState === session.ws.OPEN) session.ws.send(text);
    }

    const evt: TapeEvent = { type: 'broadcast', msg };
    this.emit('tape', evt);
    // Server-side tape.
    if (msg.type === 'job_posted') this.log(`[tape] job_posted: ${msg.job.title} (${msg.job.budget})`);
    if (msg.type === 'bid_posted') this.log(`[tape] bid: job=${msg.bid.jobId.slice(0, 8)} price=${msg.bid.price}`);
    if (msg.type === 'job_awarded')
      this.log(`[tape] awarded: job=${msg.jobId.slice(0, 8)} worker=${msg.workerId.slice(0, 8)}`);
    if (msg.type === 'job_completed') this.log(`[tape] completed: job=${msg.jobId.slice(0, 8)} paid=${msg.paid}`);
    if (msg.type === 'job_failed')
      this.log(`[tape] failed: job=${msg.jobId.slice(0, 8)} worker=${msg.workerId.slice(0, 8)} reason=${msg.reason}`);
  }

  private fail(ws: WebSocket, message: string) {
    const err: ErrorMsg = { v: PROTOCOL_VERSION, type: 'error', message };
    this.send(ws, err);
  }

  private log(line: string) {
    // Keep logs stable for the terminal sim.
    // eslint-disable-next-line no-console
    console.log(line);
  }

  async getObserverSnapshot(): Promise<ObserverSnapshot> {
    if (this.db) return await this.db.getObserverSnapshot();

    const agents: ObserverSnapshot['agents'] = [];
    for (const session of this.sessions.values()) {
      if (!session.authed || !session.agentId || !session.agentName) continue;
      const acct = this.ledger.get(session.agentId);
      if (!acct) continue;
      agents.push({
        agentId: session.agentId,
        agentName: session.agentName,
        credits: acct.credits,
        locked: acct.locked,
      });
    }

    const jobs: ObserverSnapshot['jobs'] = [];
    const bids: ObserverSnapshot['bids'] = [];
    for (const job of this.jobs.values()) {
      jobs.push({
        id: job.id,
        title: job.title,
        description: job.description,
        budget: job.budget,
        requesterId: job.requesterId,
        createdAtMs: job.createdAtMs,
        status: job.status,
        workerId: job.workerId,
        kind: job.kind,
        payload: job.payload,
      });
      bids.push(...job.bids);
    }

    return { agents, jobs, bids };
  }
}

function parsePort(): number {
  const env = process.env.SYNAPSE_PORT;
  if (!env) return 8787;
  const n = Number(env);
  return Number.isFinite(n) && n > 0 ? n : 8787;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  await import('dotenv/config');

  const port = parsePort();
  const dbUrl = process.env.DATABASE_URL;
  const db = dbUrl ? new SynapseDb({ connectionString: dbUrl }) : undefined;
  if (db) await db.ensureSchema();

  // eslint-disable-next-line no-console
  console.log(`[server] listening on ws://localhost:${port}`);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const server = new CoreServer(port, { db });
}

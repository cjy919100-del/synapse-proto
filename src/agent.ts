import WebSocket, { type RawData } from 'ws';

import { generateEd25519KeyPair, signAuth } from './crypto.js';
import {
  PROTOCOL_VERSION,
  type AgentToServerMsg,
  type BidPostedMsg,
  type ChallengeMsg,
  type JobAwardedMsg,
  type JobPostedMsg,
  type JobSubmittedMsg,
  ServerToAgentMsgSchema,
} from './protocol.js';
import { AgentLlm } from './llm.js';

type Role = 'requester' | 'worker';

type AgentConfig = {
  name: string;
  role: Role;
  url: string;
  autoLoop?: boolean; // requester auto-post loop (dev convenience). Disable for tests/scripts.
};

export class FakeAgent {
  private readonly ws: WebSocket;
  private agentId: string | null = null;
  private credits = 0;
  private locked = 0;
  private readonly keyPair = generateEd25519KeyPair();
  // Jobs we posted but haven't awarded yet. (We learn the jobId via `job_posted` broadcast.)
  private readonly ownedJobs = new Set<string>();
  private readonly unawardedOwnedJobs = new Set<string>();
  // Solutions we prepared for coding tasks (jobId -> code)
  private readonly preparedSolutions = new Map<string, Promise<string>>();
  private readonly codingPayloadByJobId = new Map<
    string,
    { description: string; template?: string; tests: any[] }
  >();
  private readonly llm = new AgentLlm();

  constructor(readonly config: AgentConfig) {
    this.ws = new WebSocket(config.url);
    this.ws.on('open', () => this.log(`[agent:${config.name}] connected`));
    this.ws.on('message', (raw: RawData) => this.onMessage(raw.toString('utf8')));
    this.ws.on('close', () => this.log(`[agent:${config.name}] disconnected`));
  }

  close() {
    this.ws.close();
  }

  private onMessage(text: string) {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return;
    }
    const parsed = ServerToAgentMsgSchema.safeParse(json);
    if (!parsed.success) return;
    const msg = parsed.data;

    switch (msg.type) {
      case 'challenge':
        return this.onChallenge(msg);
      case 'authed':
        this.agentId = msg.agentId;
        this.credits = msg.credits;
        this.log(`[agent:${this.config.name}] authed id=${msg.agentId.slice(0, 8)} credits=${msg.credits}`);
        if (this.config.role === 'requester' && this.config.autoLoop !== false) this.startRequesterLoop();
        return;
      case 'ledger_update':
        this.credits = msg.credits;
        this.locked = msg.locked ?? this.locked;
        this.log(`[agent:${this.config.name}] credits=${msg.credits}`);
        return;
      case 'job_posted':
        return this.onJobPosted(msg);
      case 'bid_posted':
        return this.onBidPosted(msg);
      case 'job_awarded':
        return this.onJobAwarded(msg);
      case 'job_submitted':
        return this.onJobSubmitted(msg);
      case 'error':
        this.log(`[agent:${this.config.name}] error=${msg.message}`);
        return;
      default:
        return;
    }
  }

  private onChallenge(msg: ChallengeMsg) {
    const signature = signAuth({
      nonceB64: msg.nonce,
      agentName: this.config.name,
      publicKeyDerB64: this.keyPair.publicKeyDerB64,
      privateKey: this.keyPair.privateKey,
    });
    const auth: AgentToServerMsg = {
      v: PROTOCOL_VERSION,
      type: 'auth',
      agentName: this.config.name,
      publicKey: this.keyPair.publicKeyDerB64,
      signature,
      nonce: msg.nonce,
    };
    this.send(auth);
  }

  private onJobPosted(msg: JobPostedMsg) {
    if (!this.agentId) return;
    if (msg.job.status !== 'open') return;

    if (this.config.role === 'requester') {
      if (msg.job.requesterId === this.agentId) {
        this.ownedJobs.add(msg.job.id);
        this.unawardedOwnedJobs.add(msg.job.id);
      }
      return;
    }

    if (this.config.role !== 'worker') return;
    if (msg.job.requesterId === this.agentId) return;

    // Simple bidding policy: bid on everything with a fixed price <= budget.
    const price = Math.min(msg.job.budget, 10);
    const bid: AgentToServerMsg = {
      v: PROTOCOL_VERSION,
      type: 'bid',
      jobId: msg.job.id,
      price,
      etaSeconds: 2,
    };
    this.send(bid);

    // If it's a coding task, start thinking about the solution NOW (async)
    if (msg.job.kind === 'coding' && msg.job.payload) {
      const payload = {
        description: (msg.job.payload.description as string) || 'unknown',
        template: msg.job.payload.template as string | undefined,
        tests: (msg.job.payload.tests as any[]) || [],
      };
      this.codingPayloadByJobId.set(msg.job.id, payload);

      // Bid first; solve asynchronously and make award wait for readiness.
      const p = this.llm.solveCodingTask(payload).catch((err) => {
        this.log(`[agent:${this.config.name}] failed to solve ${msg.job.id.slice(0, 8)}: ${err.message}`);
        return `// LLM Failed: ${err.message}\n(x) => x`;
      });
      this.preparedSolutions.set(msg.job.id, p);
      void p.then(() => this.log(`[agent:${this.config.name}] prepared solution for ${msg.job.id.slice(0, 8)}`));
    }
  }

  private onBidPosted(msg: BidPostedMsg) {
    if (!this.agentId) return;
    if (this.config.role !== 'requester') return;

    // If this requester created the job, auto-award the first bid we see.
    if (!this.unawardedOwnedJobs.has(msg.bid.jobId)) return;
    this.unawardedOwnedJobs.delete(msg.bid.jobId);

    const award: AgentToServerMsg = {
      v: PROTOCOL_VERSION,
      type: 'award',
      jobId: msg.bid.jobId,
      workerId: msg.bid.bidderId,
    };
    this.send(award);
  }

  private onJobAwarded(msg: JobAwardedMsg) {
    if (!this.agentId) return;
    if (this.config.role !== 'worker') return;
    if (msg.workerId !== this.agentId) return;

    setTimeout(() => {
      const result = `done by ${this.config.name}`;

      const maybePromise = this.preparedSolutions.get(msg.jobId);

      const submitWith = (r: string) => {
        const submit: AgentToServerMsg = {
          v: PROTOCOL_VERSION,
          type: 'submit',
          jobId: msg.jobId,
          result: r,
        };
        this.send(submit);
      };

      if (maybePromise) {
        // Wait (briefly) for the coding solution to be ready so deterministic evaluator can pass.
        const timeoutMs = 2_500;
        const timeout = new Promise<string>((resolve) =>
          setTimeout(() => resolve(result), timeoutMs),
        );
        void Promise.race([maybePromise, timeout]).then((code) => {
          this.preparedSolutions.delete(msg.jobId); // consume
          this.log(
            `[agent:${this.config.name}] submitting code for ${msg.jobId.slice(0, 8)}: ${String(code).slice(0, 80).replace(/\\s+/g, ' ')}`,
          );
          submitWith(code);
        });
        return;
      }

      // Fallback: if this was a coding job but we missed the post, try solving now (best effort).
      const payload = this.codingPayloadByJobId.get(msg.jobId);
      if (payload) {
        void this.llm.solveCodingTask(payload).then(submitWith).catch(() => submitWith(result));
        return;
      }

      submitWith(result);
    }, 1_000);
  }

  private onJobSubmitted(msg: JobSubmittedMsg) {
    if (!this.agentId) return;
    if (this.config.role !== 'requester') return;
    if (!this.ownedJobs.has(msg.jobId)) return;

    // Auto-accept for dev. AutonomousRequesterAgent will implement policy-based review.
    const review: AgentToServerMsg = {
      v: PROTOCOL_VERSION,
      type: 'review',
      jobId: msg.jobId,
      decision: 'accept',
      notes: 'auto_accept(dev)',
    };
    this.send(review);
  }

  private startRequesterLoop() {
    // Post a few jobs then stop. This is enough to validate the wire protocol + settlement.
    let n = 0;
    const interval = setInterval(() => {
      if (!this.agentId) return;
      n += 1;
      if (n > 5) {
        clearInterval(interval);
        return;
      }

      const title = `task-${n}: build login page`;
      const budget = 25;
      const post: AgentToServerMsg = { v: PROTOCOL_VERSION, type: 'post_job', title, budget };
      this.send(post);
    }, 1_500);
  }

  private send(msg: AgentToServerMsg) {
    if (this.ws.readyState !== this.ws.OPEN) return;
    this.ws.send(JSON.stringify(msg));
  }

  private log(line: string) {
    // eslint-disable-next-line no-console
    console.log(line);
  }
}

function parseArgs(argv: string[]): AgentConfig {
  const url = process.env.SYNAPSE_URL ?? 'ws://localhost:8787';
  let name = 'agent';
  let role: Role = 'worker';
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const b = argv[i + 1];
    if (a === '--name' && b) name = b;
    if (a === '--role' && (b === 'requester' || b === 'worker')) role = b;
    if (a === '--url' && b) {
      // eslint-disable-next-line no-param-reassign
      (process.env as Record<string, string>).SYNAPSE_URL = b;
    }
  }
  return { name, role, url: process.env.SYNAPSE_URL ?? url };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cfg = parseArgs(process.argv.slice(2));
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const agent = new FakeAgent(cfg);
}

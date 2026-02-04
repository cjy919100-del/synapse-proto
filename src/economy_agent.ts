import WebSocket, { type RawData } from 'ws';

import { generateEd25519KeyPair, signAuth } from './crypto.js';
import {
  PROTOCOL_VERSION,
  type AgentToServerMsg,
  type BidPostedMsg,
  type ChallengeMsg,
  type Job,
  type JobAwardedMsg,
  type JobPostedMsg,
  type JobReviewedMsg,
  type JobSubmittedMsg,
  ServerToAgentMsgSchema,
} from './protocol.js';

type EconomyAgentConfig = {
  name: string;
  url: string;
  /** If true, agent may create jobs (boss mode). */
  canBoss?: boolean;
  /** If true, agent may bid and work jobs (worker mode). */
  canWork?: boolean;
  /** Max open jobs this agent keeps posted at once. */
  maxOpenJobs?: number;
};

type BidLite = { bidderId: string; price: number; etaSeconds: number; score: number };

type BossPersonality = 'risk_averse' | 'cost_cutter' | 'speed_runner' | 'balanced';
type WorkerPersonality = 'undercutter' | 'premium' | 'sprinter' | 'selective' | 'balanced';

type Personality = {
  boss: BossPersonality;
  worker: WorkerPersonality;
};

function randInt(min: number, max: number): number {
  return Math.floor(min + Math.random() * (max - min + 1));
}

function spendable(credits: number, locked: number): number {
  return Math.max(0, credits - locked);
}

function requiredKeyword(job: Job): string {
  const kw = (job.payload as any)?.requiredKeyword;
  return typeof kw === 'string' && kw.trim() ? kw.trim() : 'SYNAPSE';
}

export class EconomyAgent {
  private readonly ws: WebSocket;
  private agentId: string | null = null;
  private credits = 0;
  private locked = 0;

  private readonly keyPair = generateEd25519KeyPair();
  private readonly openJobs = new Map<string, Job>(); // jobId -> job
  private readonly ownedOpenJobs = new Set<string>();
  private readonly bidsByJobId = new Map<string, BidLite[]>();
  private readonly awardTimers = new Map<string, NodeJS.Timeout>();
  private readonly assignedJobs = new Set<string>();

  private postTimer: NodeJS.Timeout | null = null;
  private readonly persona: Personality = {
    boss: (['risk_averse', 'cost_cutter', 'speed_runner', 'balanced'] as const)[randInt(0, 3)]!,
    worker: (['undercutter', 'premium', 'sprinter', 'selective', 'balanced'] as const)[randInt(0, 4)]!,
  };

  constructor(readonly cfg: EconomyAgentConfig) {
    this.ws = new WebSocket(cfg.url);
    this.ws.on('open', () => this.log(`[eco:${cfg.name}] connected`));
    this.ws.on('message', (raw: RawData) => this.onMessage(raw.toString('utf8')));
    this.ws.on('close', () => this.log(`[eco:${cfg.name}] disconnected`));
  }

  close() {
    if (this.postTimer) clearInterval(this.postTimer);
    for (const t of this.awardTimers.values()) clearTimeout(t);
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
        this.log(`[eco:${this.cfg.name}] authed id=${msg.agentId.slice(0, 8)} credits=${msg.credits}`);
        this.startLoops();
        return;
      case 'ledger_update':
        this.credits = msg.credits;
        this.locked = msg.locked ?? this.locked;
        return;
      case 'job_posted':
        return this.onJobPosted(msg);
      case 'bid_posted':
        return this.onBidPosted(msg);
      case 'job_awarded':
        return this.onJobAwarded(msg);
      case 'job_submitted':
        return this.onJobSubmitted(msg);
      case 'job_reviewed':
        return this.onJobReviewed(msg);
      default:
        return;
    }
  }

  private onChallenge(msg: ChallengeMsg) {
    const signature = signAuth({
      nonceB64: msg.nonce,
      agentName: this.cfg.name,
      publicKeyDerB64: this.keyPair.publicKeyDerB64,
      privateKey: this.keyPair.privateKey,
    });
    const auth: AgentToServerMsg = {
      v: PROTOCOL_VERSION,
      type: 'auth',
      agentName: this.cfg.name,
      publicKey: this.keyPair.publicKeyDerB64,
      signature,
      nonce: msg.nonce,
    };
    this.send(auth);
  }

  private startLoops() {
    if (!this.agentId) return;
    const canBoss = this.cfg.canBoss !== false;
    if (!canBoss) return;

    const maxOpen = this.cfg.maxOpenJobs ?? 1;
    this.postTimer = setInterval(() => {
      if (!this.agentId) return;
      if (this.ownedOpenJobs.size >= maxOpen) return;
      if (spendable(this.credits, this.locked) < 500) return;

      const kw = `K${randInt(100, 999)}`;
      const budget = randInt(200, 600);
      const payload = {
        requiredKeyword: kw,
        timeoutSeconds: randInt(6, 12),
      };
      const post: AgentToServerMsg = {
        v: PROTOCOL_VERSION,
        type: 'post_job',
        title: `Write 1-line update including "${kw}"`,
        description: `Return exactly one sentence that includes the keyword "${kw}".`,
        budget,
        kind: 'simple',
        payload,
      };
      this.send(post);
    }, 3_000);
  }

  private onJobPosted(msg: JobPostedMsg) {
    if (!this.agentId) return;
    const job = msg.job;
    this.openJobs.set(job.id, job);

    if (job.status === 'open' && job.requesterId === this.agentId) {
      this.ownedOpenJobs.add(job.id);
      return;
    }

    const canWork = this.cfg.canWork !== false;
    if (!canWork) return;
    if (job.status !== 'open') return;
    if (job.requesterId === this.agentId) return;
    if (spendable(this.credits, this.locked) < 50) return;

    // Bid on a subset to avoid everyone bidding on everything.
    if (this.persona.worker === 'selective' && job.budget < 350) return;
    if (Math.random() < 0.25) return;

    const [minP, maxP] = (() => {
      if (this.persona.worker === 'undercutter') return [0.2, 0.5] as const;
      if (this.persona.worker === 'premium') return [0.7, 0.95] as const;
      return [0.35, 0.8] as const;
    })();
    const price = Math.max(
      10,
      Math.min(job.budget, randInt(Math.floor(job.budget * minP), Math.floor(job.budget * maxP))),
    );
    const etaSeconds = this.persona.worker === 'sprinter' ? randInt(1, 4) : randInt(2, 10);
    const pitch = this.makePitch(job, price, etaSeconds);
    const bid: AgentToServerMsg = { v: PROTOCOL_VERSION, type: 'bid', jobId: job.id, price, etaSeconds, pitch };
    this.send(bid);
  }

  private onBidPosted(msg: BidPostedMsg) {
    if (!this.agentId) return;
    const bid = msg.bid;
    const job = this.openJobs.get(bid.jobId);
    if (!job) return;
    if (job.status !== 'open') return;
    if (job.requesterId !== this.agentId) return;

    const score = bid.bidderRep?.score ?? 0.5;
    const list = this.bidsByJobId.get(bid.jobId) ?? [];
    list.push({ bidderId: bid.bidderId, price: bid.price, etaSeconds: bid.etaSeconds, score });
    this.bidsByJobId.set(bid.jobId, list);

    // Debounced award: wait briefly to gather bids, then pick best.
    if (!this.awardTimers.has(bid.jobId)) {
      this.awardTimers.set(
        bid.jobId,
        setTimeout(() => {
          this.awardTimers.delete(bid.jobId);
          void this.pickWinnerAndAward(bid.jobId);
        }, 1_200),
      );
    }
  }

  private async pickWinnerAndAward(jobId: string) {
    if (!this.agentId) return;
    const job = this.openJobs.get(jobId);
    if (!job || job.status !== 'open') return;
    if (job.requesterId !== this.agentId) return;

    const bids = this.bidsByJobId.get(jobId) ?? [];
    if (bids.length === 0) return;

    // Personality-driven utility.
    const utility = (b: BidLite) => {
      const rep = b.score;
      const price = b.price;
      const eta = b.etaSeconds;

      if (this.persona.boss === 'risk_averse') return rep * 100 - price * 0.4 - eta * 1.2;
      if (this.persona.boss === 'cost_cutter') return rep * 40 - price * 1.2 - eta * 0.6;
      if (this.persona.boss === 'speed_runner') return rep * 40 - price * 0.5 - eta * 2.0;
      return rep * 60 - price * 0.7 - eta * 0.9; // balanced
    };

    bids.sort((a, b) => utility(b) - utility(a));
    const winner = bids[0]!;

    const award: AgentToServerMsg = {
      v: PROTOCOL_VERSION,
      type: 'award',
      jobId,
      workerId: winner.bidderId,
      notes: `boss=${this.persona.boss} picked rep=${winner.score.toFixed(2)} price=${winner.price} eta=${winner.etaSeconds}`,
    };
    this.send(award);

    // This job is no longer open (server will broadcast award), but we can optimistically stop posting duplicates.
    this.ownedOpenJobs.delete(jobId);
  }

  private onJobAwarded(msg: JobAwardedMsg) {
    if (!this.agentId) return;
    const job = this.openJobs.get(msg.jobId);
    if (job) this.openJobs.set(msg.jobId, { ...job, status: 'awarded', workerId: msg.workerId });

    if (msg.workerId !== this.agentId) return;
    this.assignedJobs.add(msg.jobId);

    setTimeout(() => {
      const j = this.openJobs.get(msg.jobId);
      const kw = j ? requiredKeyword(j) : 'SYNAPSE';
      const willFail = Math.random() < 0.18;
      const result = willFail ? 'I forgot the keyword.' : `Done. ${kw}`;
      const submit: AgentToServerMsg = { v: PROTOCOL_VERSION, type: 'submit', jobId: msg.jobId, result };
      this.send(submit);
    }, randInt(800, 1_800));
  }

  private onJobSubmitted(msg: JobSubmittedMsg) {
    if (!this.agentId) return;
    const job = this.openJobs.get(msg.jobId);
    if (job) this.openJobs.set(msg.jobId, { ...job, status: 'in_review' });

    // Boss policy: accept if keyword present; otherwise request changes or reject.
    if (job && job.requesterId === this.agentId) {
      const kw = requiredKeyword(job);
      const preview = msg.preview ?? '';
      const hasKw = preview.includes(kw);

      let decision: 'accept' | 'reject' | 'changes' = 'accept';
      let notes = '';
      if (!hasKw) {
        decision = this.persona.boss === 'risk_averse' ? 'reject' : Math.random() < 0.75 ? 'changes' : 'reject';
        notes = `missing_keyword:${kw}`;
      } else {
        notes = 'ok';
      }

      const review: AgentToServerMsg = { v: PROTOCOL_VERSION, type: 'review', jobId: msg.jobId, decision, notes };
      setTimeout(() => this.send(review), randInt(300, 900));
    }
  }

  private onJobReviewed(msg: JobReviewedMsg) {
    if (!this.agentId) return;
    // If this agent is the worker and changes were requested, resubmit with a corrected answer.
    if (msg.decision !== 'changes') return;
    if (!this.assignedJobs.has(msg.jobId)) return;

    const job = this.openJobs.get(msg.jobId);
    const kw = job ? requiredKeyword(job) : 'SYNAPSE';
    const result = `Updated. ${kw}`;
    const submit: AgentToServerMsg = { v: PROTOCOL_VERSION, type: 'submit', jobId: msg.jobId, result };
    setTimeout(() => this.send(submit), randInt(600, 1_400));
  }

  private send(msg: AgentToServerMsg) {
    if (this.ws.readyState !== this.ws.OPEN) return;
    this.ws.send(JSON.stringify(msg));
  }

  private makePitch(job: Job, price: number, etaSeconds: number): string {
    const kw = requiredKeyword(job);
    const style = this.persona.worker;
    if (style === 'undercutter') return `Low-cost fast delivery. Will include keyword "${kw}". price=${price} eta=${etaSeconds}s`;
    if (style === 'premium') return `High quality. I will verify keyword "${kw}" and keep it clean. price=${price} eta=${etaSeconds}s`;
    if (style === 'sprinter') return `Speedrun. Keyword "${kw}" guaranteed. price=${price} eta=${etaSeconds}s`;
    if (style === 'selective') return `Selective worker. Taking this only because budget is fair. Keyword "${kw}". price=${price} eta=${etaSeconds}s`;
    return `Balanced bid. Includes "${kw}". price=${price} eta=${etaSeconds}s`;
  }

  private log(line: string) {
    // eslint-disable-next-line no-console
    console.log(line);
  }
}

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
  type JobUpdatedMsg,
  type JobReviewedMsg,
  type JobSubmittedMsg,
  type OfferMadeMsg,
  type OfferResponseMsg,
  type CounterMadeMsg,
  type NegotiationEndedMsg,
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
  /** Real backlog tasks; posted before synthetic jobs. */
  backlogJobs?: RealJobSeed[];
  /** If false, do not generate synthetic jobs after backlog is exhausted. */
  syntheticFallback?: boolean;
};

export type RealJobSeed = {
  title: string;
  description?: string;
  budget: number;
  kind?: string;
  payload?: Record<string, unknown>;
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
  private readonly bidSentByJobId = new Set<string>();
  private readonly awardTimers = new Map<string, NodeJS.Timeout>();
  private readonly assignedJobs = new Set<string>();
  private readonly rejectedWorkersByJobId = new Map<string, Set<string>>();
  private readonly backlogQueue: RealJobSeed[];

  private postTimer: NodeJS.Timeout | null = null;
  private readonly persona: Personality = {
    boss: (['risk_averse', 'cost_cutter', 'speed_runner', 'balanced'] as const)[randInt(0, 3)]!,
    worker: (['undercutter', 'premium', 'sprinter', 'selective', 'balanced'] as const)[randInt(0, 4)]!,
  };

  constructor(readonly cfg: EconomyAgentConfig) {
    this.ws = new WebSocket(cfg.url);
    this.backlogQueue = [...(cfg.backlogJobs ?? [])];
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
      case 'job_updated':
        return this.onJobUpdated(msg);
      case 'bid_posted':
        return this.onBidPosted(msg);
      case 'job_awarded':
        return this.onJobAwarded(msg);
      case 'job_submitted':
        return this.onJobSubmitted(msg);
      case 'job_reviewed':
        return this.onJobReviewed(msg);
      case 'offer_made':
        return this.onOfferMade(msg);
      case 'offer_response':
        return this.onOfferResponse(msg);
      case 'counter_made':
        return this.onCounterMade(msg);
      case 'negotiation_ended':
        return this.onNegotiationEnded(msg);
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

      const post = this.nextPostJob();
      if (!post) return;
      this.send(post);
    }, 3_000);
  }

  private nextPostJob(): AgentToServerMsg | null {
    const real = this.backlogQueue.shift();
    if (real) {
      const budget = Math.max(10, Math.floor(real.budget));
      return {
        v: PROTOCOL_VERSION,
        type: 'post_job',
        title: real.title,
        description: real.description,
        budget,
        kind: real.kind ?? 'simple',
        payload: real.payload ?? {},
      };
    }

    const allowSynthetic = this.cfg.syntheticFallback !== false;
    if (!allowSynthetic) return null;

    const kw = `K${randInt(100, 999)}`;
    const budget = randInt(200, 600);
    const payload = {
      requiredKeyword: kw,
      timeoutSeconds: randInt(6, 12),
    };
    return {
      v: PROTOCOL_VERSION,
      type: 'post_job',
      title: `Write 1-line update including "${kw}"`,
      description: `Return exactly one sentence that includes the keyword "${kw}".`,
      budget,
      kind: 'simple',
      payload,
    };
  }

  private onJobPosted(msg: JobPostedMsg) {
    this.onJobUpsert(msg.job);
  }

  private onJobUpdated(msg: JobUpdatedMsg) {
    this.onJobUpsert(msg.job);
  }

  private onJobUpsert(job: Job) {
    if (!this.agentId) return;
    this.openJobs.set(job.id, job);

    if (job.status === 'open' && job.requesterId === this.agentId) {
      this.ownedOpenJobs.add(job.id);
      return;
    }
    if (job.requesterId === this.agentId) this.ownedOpenJobs.delete(job.id);

    const canWork = this.cfg.canWork !== false;
    if (!canWork) return;
    if (job.status !== 'open') {
      this.bidSentByJobId.delete(job.id);
      return;
    }
    if (job.requesterId === this.agentId) return;
    if (this.bidSentByJobId.has(job.id)) return;
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
    const terms = this.makeTermsFor(job, price, etaSeconds);
    const bid: AgentToServerMsg = { v: PROTOCOL_VERSION, type: 'bid', jobId: job.id, price, etaSeconds, pitch, terms };
    this.send(bid);
    this.bidSentByJobId.add(job.id);
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

  private makeTermsFor(job: Job, price: number, etaSeconds: number) {
    // Keep it simple/visible: some workers ask for upfront + limited revisions, others are flexible.
    const upfrontPct = (() => {
      if (this.persona.worker === 'premium') return 0.25;
      if (this.persona.worker === 'undercutter') return 0;
      return Math.random() < 0.25 ? 0.1 : 0;
    })();
    const deadlineSeconds = Math.max(etaSeconds * 2, Math.min(20, (job.payload as any)?.timeoutSeconds ?? 12));
    const maxRevisions = this.persona.worker === 'premium' ? 2 : this.persona.worker === 'sprinter' ? 0 : 1;
    return { upfrontPct, deadlineSeconds, maxRevisions };
  }

  private async pickWinnerAndAward(jobId: string) {
    if (!this.agentId) return;
    const job = this.openJobs.get(jobId);
    if (!job || job.status !== 'open') return;
    if (job.requesterId !== this.agentId) return;

    const rejected = this.rejectedWorkersByJobId.get(jobId) ?? new Set<string>();
    const bids = (this.bidsByJobId.get(jobId) ?? []).filter((b) => !rejected.has(b.bidderId));
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

    // Negotiate before awarding: boss proposes terms based on personality.
    const baseTerms = { upfrontPct: 0, deadlineSeconds: Math.max(6, winner.etaSeconds * 3), maxRevisions: 1 };
    const terms =
      this.persona.boss === 'risk_averse'
        ? { ...baseTerms, upfrontPct: 0, maxRevisions: 0 }
        : this.persona.boss === 'cost_cutter'
          ? { ...baseTerms, upfrontPct: 0, maxRevisions: 1 }
          : this.persona.boss === 'speed_runner'
            ? { ...baseTerms, deadlineSeconds: Math.max(4, winner.etaSeconds * 2), maxRevisions: 0 }
            : { ...baseTerms, upfrontPct: 0.1, maxRevisions: 1 };
    const price = (() => {
      if (this.persona.boss === 'cost_cutter') return Math.max(10, Math.floor(winner.price * 0.85));
      if (this.persona.boss === 'risk_averse') return Math.max(10, Math.floor(winner.price * 0.95));
      if (this.persona.boss === 'speed_runner') return Math.max(10, Math.floor(winner.price * 1.03));
      return winner.price;
    })();
    const offerPrice = Math.min(job.budget, Math.max(10, price));

    const offer: AgentToServerMsg = {
      v: PROTOCOL_VERSION,
      type: 'counter_offer',
      jobId,
      workerId: winner.bidderId,
      price: offerPrice,
      terms,
      notes: `boss=${this.persona.boss} counter_terms price=${offerPrice} upfront=${Math.round(terms.upfrontPct * 100)}% deadline=${terms.deadlineSeconds}s rev=${terms.maxRevisions}`,
    };
    this.send(offer);
  }

  private onJobAwarded(msg: JobAwardedMsg) {
    if (!this.agentId) return;
    const job = this.openJobs.get(msg.jobId);
    if (job) this.openJobs.set(msg.jobId, { ...job, status: 'awarded', workerId: msg.workerId });

    // If this agent owns the job, it should no longer count as an open contract.
    const owned = this.openJobs.get(msg.jobId);
    if (owned && owned.requesterId === this.agentId) this.ownedOpenJobs.delete(msg.jobId);

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

  private onOfferMade(msg: OfferMadeMsg) {
    if (!this.agentId) return;
    if (msg.workerId !== this.agentId) return;

    // Worker decides based on personality: premium likes upfront; undercutter dislikes revisions; sprinter dislikes long deadline.
    const t = msg.terms;
    const job = this.openJobs.get(msg.jobId);
    const budget = job?.budget ?? msg.price;
    const minAcceptPrice = (() => {
      if (this.persona.worker === 'premium') return Math.ceil(budget * 0.7);
      if (this.persona.worker === 'sprinter') return Math.ceil(budget * 0.55);
      if (this.persona.worker === 'selective') return Math.ceil(budget * 0.5);
      if (this.persona.worker === 'balanced') return Math.ceil(budget * 0.45);
      return Math.ceil(budget * 0.3);
    })();
    let accept = true;
    if (this.persona.worker === 'undercutter' && t.upfrontPct > 0) accept = false;
    if (this.persona.worker === 'sprinter' && t.deadlineSeconds > 12) accept = false;
    if (this.persona.worker === 'premium' && t.upfrontPct < 0.1) accept = Math.random() < 0.65;
    if (this.persona.worker === 'selective' && t.maxRevisions > 1) accept = false;
    if (msg.price < minAcceptPrice) accept = false;

    // Sometimes counter instead of hard reject to make negotiation feel real.
    const wantsCounter = !accept ? Math.random() < 0.8 : Math.random() < 0.15;
    if (wantsCounter && (this.persona.worker === 'premium' || this.persona.worker === 'sprinter' || this.persona.worker === 'balanced')) {
      const counter = { ...t };
      if (this.persona.worker === 'premium') counter.upfrontPct = Math.min(0.35, Math.max(counter.upfrontPct, 0.2));
      if (this.persona.worker === 'sprinter') counter.deadlineSeconds = Math.max(4, Math.min(counter.deadlineSeconds, 10));
      if (this.persona.worker === 'balanced') counter.maxRevisions = Math.max(0, Math.min(counter.maxRevisions, 1));
      const counterPrice = (() => {
        if (this.persona.worker === 'premium') return Math.ceil(Math.max(msg.price + 12, budget * 0.8));
        if (this.persona.worker === 'sprinter') return Math.ceil(Math.max(msg.price + 6, budget * 0.6));
        return Math.ceil(Math.max(msg.price + 4, budget * 0.55));
      })();
      const price = Math.min(budget, Math.max(10, counterPrice));

      const msgOut: AgentToServerMsg = {
        v: PROTOCOL_VERSION,
        type: 'worker_counter',
        jobId: msg.jobId,
        requesterId: msg.requesterId,
        price,
        terms: counter,
        notes: `worker=${this.persona.worker} counter price=${price}`,
      };
      setTimeout(() => this.send(msgOut), randInt(300, 900));
      return;
    }

    const decision: AgentToServerMsg = {
      v: PROTOCOL_VERSION,
      type: 'offer_decision',
      jobId: msg.jobId,
      requesterId: msg.requesterId,
      decision: accept ? 'accept' : 'reject',
      notes: `worker=${this.persona.worker}`,
    };
    setTimeout(() => this.send(decision), randInt(300, 900));
  }

  private onOfferResponse(_msg: OfferResponseMsg) {
    // If a worker rejects, a boss should try another candidate to keep the world moving.
    if (!this.agentId) return;
    if (_msg.requesterId !== this.agentId) return;
    if (_msg.decision !== 'reject') return;
    const set = this.rejectedWorkersByJobId.get(_msg.jobId) ?? new Set<string>();
    set.add(_msg.workerId);
    this.rejectedWorkersByJobId.set(_msg.jobId, set);
    setTimeout(() => void this.pickWinnerAndAward(_msg.jobId), randInt(400, 1_200));
  }

  private onCounterMade(msg: CounterMadeMsg) {
    if (!this.agentId) return;
    // Only bosses respond to worker counters for their own jobs.
    if (msg.requesterId !== this.agentId) return;
    if (msg.fromRole !== 'worker') return;

    const job = this.openJobs.get(msg.jobId);
    const budget = job?.budget ?? msg.price;
    const base = msg.terms;
    const maxAcceptPrice = (() => {
      if (this.persona.boss === 'cost_cutter') return Math.floor(budget * 0.65);
      if (this.persona.boss === 'risk_averse') return Math.floor(budget * 0.8);
      if (this.persona.boss === 'speed_runner') return Math.floor(budget * 0.9);
      return Math.floor(budget * 0.8);
    })();
    const acceptable = (() => {
      if (msg.price > maxAcceptPrice) return false;
      if (this.persona.boss === 'risk_averse') return base.maxRevisions <= 0 && base.upfrontPct <= 0.1;
      if (this.persona.boss === 'cost_cutter') return base.upfrontPct <= 0.1;
      if (this.persona.boss === 'speed_runner') return base.deadlineSeconds <= 10 && base.maxRevisions <= 0;
      return true;
    })();

    const terms = (() => {
      if (acceptable) return base;
      const t = { ...base };
      if (this.persona.boss === 'cost_cutter') t.upfrontPct = 0;
      if (this.persona.boss === 'risk_averse') t.maxRevisions = 0;
      if (this.persona.boss === 'speed_runner') t.deadlineSeconds = Math.max(4, Math.min(10, t.deadlineSeconds));
      // balanced: small concession
      if (this.persona.boss === 'balanced') t.maxRevisions = Math.max(0, Math.min(1, t.maxRevisions));
      return t;
    })();
    const price = (() => {
      if (acceptable) return msg.price;
      const cap = Math.max(10, maxAcceptPrice);
      const blended = Math.floor((msg.price + cap) / 2);
      return Math.min(budget, Math.max(10, blended));
    })();

    const offer: AgentToServerMsg = {
      v: PROTOCOL_VERSION,
      type: 'counter_offer',
      jobId: msg.jobId,
      workerId: msg.workerId,
      price,
      terms,
      notes: acceptable
        ? `boss=${this.persona.boss} accept_counter price=${price}`
        : `boss=${this.persona.boss} counter_back price=${price}`,
    };
    setTimeout(() => this.send(offer), randInt(350, 1_100));
  }

  private onNegotiationEnded(msg: NegotiationEndedMsg) {
    if (!this.agentId) return;
    if (msg.requesterId !== this.agentId) return; // bosses only
    // Mark the worker as "do not pick" for this job, then try the next best bid.
    const set = this.rejectedWorkersByJobId.get(msg.jobId) ?? new Set<string>();
    set.add(msg.workerId);
    this.rejectedWorkersByJobId.set(msg.jobId, set);
    setTimeout(() => void this.pickWinnerAndAward(msg.jobId), randInt(450, 1_250));
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

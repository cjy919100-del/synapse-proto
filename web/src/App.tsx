import React, { useEffect, useMemo, useReducer, useRef, useState } from 'react';

import { Badge } from './components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './components/ui/card';
import { Separator } from './components/ui/separator';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './components/ui/table';
import { cn } from './lib/utils';

type Agent = {
  agentId: string;
  agentName: string;
  credits: number;
  locked: number;
  rep: { completed: number; failed: number; score: number };
};
type JobStatus = 'open' | 'awarded' | 'in_review' | 'completed' | 'cancelled' | 'failed';
type Job = {
  id: string;
  title: string;
  description?: string;
  budget: number;
  requesterId: string;
  createdAtMs: number;
  status: JobStatus;
  workerId?: string;
  kind?: string;
  payload?: Record<string, unknown>;
};
type Bid = {
  id: string;
  jobId: string;
  bidderId: string;
  price: number;
  etaSeconds: number;
  createdAtMs: number;
  pitch?: string;
  terms?: { upfrontPct: number; deadlineSeconds: number; maxRevisions: number };
  bidderRep?: { completed: number; failed: number; score: number };
};

type EvidenceItem = { id: string; atMs: number; jobId: string; kind: string; detail: string };

type Snapshot = { agents: Agent[]; jobs: Job[]; bids: Bid[]; evidence: EvidenceItem[] };

type TapeEvent =
  | { type: 'agent_authed'; agentId: string; agentName: string; credits: number }
  | { type: 'ledger_update'; agentId: string; credits: number; locked: number }
  | { type: 'rep_update'; agentId: string; completed: number; failed: number; score: number }
  | { type: 'evidence'; jobId: string; kind: string; detail: string }
  | { type: 'broadcast'; msg: unknown };

type SpectatorMsg = { v: number; type: 'snapshot'; data: Snapshot } | { v: number; type: 'event'; data: TapeEvent };

type ConnectionStatus = 'connecting' | 'open' | 'closed';

type TapeRow = {
  id: string;
  atMs: number;
  kind: 'JOB' | 'BID' | 'AWARD' | 'DONE' | 'LEDGER' | 'AGENT' | 'REP' | 'EVD' | 'OTHER';
  detail: string;
};

type State = {
  status: ConnectionStatus;
  wsUrl: string;
  agents: Record<string, Agent>;
  baselineCredits: Record<string, number>;
  jobs: Record<string, Job>;
  bids: Record<string, Bid>;
  evidence: EvidenceItem[];
  tape: TapeRow[];
  totalEvents: number;
};

type Action =
  | { type: 'status'; status: ConnectionStatus }
  | { type: 'snapshot'; snapshot: Snapshot }
  | { type: 'event'; event: TapeEvent };

function shortId(id: string | undefined, n = 8) {
  if (!id) return '-';
  return id.slice(0, n);
}

function nowId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function defaultWsUrl(): string {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const isVite = window.location.port === '5173';
  const host = isVite ? `${window.location.hostname}:8790` : window.location.host;
  return `${proto}://${host}/observer`;
}

function badgeForKind(kind: TapeRow['kind']) {
  switch (kind) {
    case 'JOB':
      return { label: 'JOB', variant: 'default' as const };
    case 'BID':
      return { label: 'BID', variant: 'accent' as const };
    case 'AWARD':
      return { label: 'AWARD', variant: 'secondary' as const };
    case 'DONE':
      return { label: 'DONE', variant: 'default' as const };
    case 'LEDGER':
      return { label: 'LEDGER', variant: 'destructive' as const };
    case 'AGENT':
      return { label: 'AGENT', variant: 'outline' as const };
    case 'REP':
      return { label: 'REP', variant: 'accent' as const };
    case 'EVD':
      return { label: 'EVD', variant: 'outline' as const };
    default:
      return { label: 'EVT', variant: 'outline' as const };
  }
}

function reduce(state: State, action: Action): State {
  switch (action.type) {
    case 'status':
      return { ...state, status: action.status };
    case 'snapshot': {
      const agents: Record<string, Agent> = {};
      for (const a of action.snapshot.agents) agents[a.agentId] = a;

      const jobs: Record<string, Job> = {};
      for (const j of action.snapshot.jobs) jobs[j.id] = j;

      const bids: Record<string, Bid> = {};
      for (const b of action.snapshot.bids) bids[b.id] = b;

      const baselineCredits = { ...state.baselineCredits };
      for (const a of action.snapshot.agents) {
        if (baselineCredits[a.agentId] == null) baselineCredits[a.agentId] = a.credits;
      }

      return { ...state, agents, baselineCredits, jobs, bids, evidence: action.snapshot.evidence ?? [] };
    }
    case 'event': {
      const next: State = {
        ...state,
        agents: { ...state.agents },
        baselineCredits: { ...state.baselineCredits },
        jobs: { ...state.jobs },
        bids: { ...state.bids },
        evidence: [...state.evidence],
        totalEvents: state.totalEvents + 1,
      };

      const row = eventToTapeRow(action.event);
      if (row) {
        next.tape = [row, ...state.tape].slice(0, 120);
      } else {
        next.tape = state.tape;
      }

      // Apply event to snapshot model.
      if (action.event.type === 'agent_authed') {
        const prev = next.agents[action.event.agentId];
        if (next.baselineCredits[action.event.agentId] == null) next.baselineCredits[action.event.agentId] = action.event.credits;
        next.agents[action.event.agentId] = {
          agentId: action.event.agentId,
          agentName: action.event.agentName,
          credits: action.event.credits,
          locked: prev?.locked ?? 0,
          rep: prev?.rep ?? { completed: 0, failed: 0, score: 0.5 },
        };
      } else if (action.event.type === 'ledger_update') {
        const prev = next.agents[action.event.agentId];
        if (next.baselineCredits[action.event.agentId] == null) next.baselineCredits[action.event.agentId] = action.event.credits;
        next.agents[action.event.agentId] = {
          agentId: action.event.agentId,
          agentName: prev?.agentName ?? shortId(action.event.agentId),
          credits: action.event.credits,
          locked: action.event.locked,
          rep: prev?.rep ?? { completed: 0, failed: 0, score: 0.5 },
        };
      } else if (action.event.type === 'rep_update') {
        const prev = next.agents[action.event.agentId];
        next.agents[action.event.agentId] = {
          agentId: action.event.agentId,
          agentName: prev?.agentName ?? shortId(action.event.agentId),
          credits: prev?.credits ?? 0,
          locked: prev?.locked ?? 0,
          rep: { completed: action.event.completed, failed: action.event.failed, score: action.event.score },
        };
      } else if (action.event.type === 'evidence') {
        const item: EvidenceItem = {
          id: nowId(),
          atMs: Date.now(),
          jobId: action.event.jobId,
          kind: action.event.kind,
          detail: action.event.detail,
        };
        next.evidence = [item, ...next.evidence].slice(0, 500);
      } else if (action.event.type === 'broadcast') {
        const msg = action.event.msg;
        if (isObject(msg) && typeof msg.type === 'string') {
          if (msg.type === 'job_posted' && isObject(msg.job) && typeof msg.job.id === 'string') {
            next.jobs[msg.job.id] = msg.job as Job;
          }
          if (msg.type === 'bid_posted' && isObject(msg.bid) && typeof msg.bid.id === 'string') {
            next.bids[msg.bid.id] = msg.bid as Bid;
          }
          if (msg.type === 'job_awarded' && typeof msg.jobId === 'string') {
            const prev = next.jobs[msg.jobId];
            if (prev) next.jobs[msg.jobId] = { ...prev, status: 'awarded', workerId: String(msg.workerId ?? '') };
          }
          if (msg.type === 'job_submitted' && typeof msg.jobId === 'string') {
            const prev = next.jobs[msg.jobId];
            if (prev) next.jobs[msg.jobId] = { ...prev, status: 'in_review' };
          }
          if (msg.type === 'job_reviewed' && typeof msg.jobId === 'string') {
            // For changes, the job becomes awarded again. For accept/reject, a later message will settle it.
            const prev = next.jobs[msg.jobId];
            if (prev && (msg as any).decision === 'changes') next.jobs[msg.jobId] = { ...prev, status: 'awarded' };
          }
          if (msg.type === 'job_completed' && typeof msg.jobId === 'string') {
            const prev = next.jobs[msg.jobId];
            if (prev) next.jobs[msg.jobId] = { ...prev, status: 'completed' };
          }
          if (msg.type === 'job_failed' && typeof (msg as any).jobId === 'string') {
            const prev = next.jobs[(msg as any).jobId];
            if (prev) next.jobs[(msg as any).jobId] = { ...prev, status: 'failed' };
          }
        }
      }

      return next;
    }
    default:
      return state;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function eventToTapeRow(evt: TapeEvent): TapeRow | null {
  const atMs = Date.now();
  if (evt.type === 'agent_authed') {
    return {
      id: nowId(),
      atMs,
      kind: 'AGENT',
      detail: `Agent joined: ${evt.agentName} (wallet=${evt.credits})`,
    };
  }
  if (evt.type === 'rep_update') {
    const pct = Math.round(evt.score * 100);
    return {
      id: nowId(),
      atMs,
      kind: 'REP',
      detail: `Reputation: ${shortId(evt.agentId)} -> ${pct}% (${evt.completed} ok / ${evt.failed} fail)`,
    };
  }
  if (evt.type === 'evidence') {
    return {
      id: nowId(),
      atMs,
      kind: 'EVD',
      detail: `Evidence: job=${shortId(evt.jobId)} ${evt.kind} • ${evt.detail}`,
    };
  }
  if (evt.type === 'ledger_update') {
    return {
      id: nowId(),
      atMs,
      kind: 'LEDGER',
      detail: `Wallet: ${shortId(evt.agentId)} spendable=${evt.credits - evt.locked} locked=${evt.locked}`,
    };
  }
  if (evt.type === 'broadcast') {
    const msg = evt.msg;
    if (!isObject(msg) || typeof msg.type !== 'string') {
      return { id: nowId(), atMs, kind: 'OTHER', detail: 'event' };
    }
    const t = msg.type;
    if (t === 'job_posted' && isObject(msg.job)) {
      const job = msg.job as Partial<Job>;
      return {
        id: nowId(),
        atMs,
        kind: 'JOB',
        detail: `New contract: "${job.title ?? '?'}" (budget=${job.budget ?? '?'})`,
      };
    }
    if (t === 'bid_posted' && isObject(msg.bid)) {
      const bid = msg.bid as Partial<Bid>;
      return {
        id: nowId(),
        atMs,
        kind: 'BID',
        detail: `Bid: job=${shortId(bid.jobId)} price=${bid.price ?? '?'} by ${shortId(bid.bidderId)}`,
      };
    }
    if (t === 'job_awarded') {
      return {
        id: nowId(),
        atMs,
        kind: 'AWARD',
        detail: `Awarded: job=${shortId(String(msg.jobId ?? ''))} -> worker ${shortId(String(msg.workerId ?? ''))} (escrow=${msg.budgetLocked ?? '?'})`,
      };
    }
    if (t === 'job_submitted') {
      return {
        id: nowId(),
        atMs,
        kind: 'OTHER',
        detail: `Submitted: job=${shortId(String((msg as any).jobId ?? ''))} bytes=${String((msg as any).bytes ?? '?')} -> awaiting boss review`,
      };
    }
    if (t === 'job_reviewed') {
      return {
        id: nowId(),
        atMs,
        kind: 'OTHER',
        detail: `Boss decision: job=${shortId(String((msg as any).jobId ?? ''))} decision=${String((msg as any).decision ?? '?')}`,
      };
    }
    if (t === 'offer_made') {
      const terms = (msg as any).terms;
      const upfront = terms && typeof terms.upfrontPct === 'number' ? Math.round(terms.upfrontPct * 100) : '?';
      return {
        id: nowId(),
        atMs,
        kind: 'OTHER',
        detail: `Negotiation: boss -> worker ${shortId(String((msg as any).workerId ?? ''))} (upfront=${upfront}%)`,
      };
    }
    if (t === 'counter_made') {
      const terms = (msg as any).terms;
      const upfront = terms && typeof terms.upfrontPct === 'number' ? Math.round(terms.upfrontPct * 100) : '?';
      const fromRole = String((msg as any).fromRole ?? '?');
      const round = String((msg as any).round ?? '?');
      return {
        id: nowId(),
        atMs,
        kind: 'OTHER',
        detail: `Negotiation r${round}: ${fromRole} proposes (upfront=${upfront}%)`,
      };
    }
    if (t === 'negotiation_ended') {
      return {
        id: nowId(),
        atMs,
        kind: 'OTHER',
        detail: `Negotiation ended: job=${shortId(String((msg as any).jobId ?? ''))} reason=${String((msg as any).reason ?? '?')}`,
      };
    }
    if (t === 'offer_response') {
      return {
        id: nowId(),
        atMs,
        kind: 'OTHER',
        detail: `Negotiation: worker ${shortId(String((msg as any).workerId ?? ''))} ${String((msg as any).decision ?? '?')}`,
      };
    }
    if (t === 'job_completed') {
      return {
        id: nowId(),
        atMs,
        kind: 'DONE',
        detail: `Settled (success): job=${shortId(String(msg.jobId ?? ''))} paid=${msg.paid ?? '?'}`,
      };
    }
    if (t === 'job_failed') {
      return {
        id: nowId(),
        atMs,
        kind: 'DONE',
        detail: `Settled (failed): job=${shortId(String((msg as any).jobId ?? ''))} reason=${String((msg as any).reason ?? '?')}`,
      };
    }
    return { id: nowId(), atMs, kind: 'OTHER', detail: t };
  }
  return null;
}

function formatTime(ms: number) {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function statusPill(status: JobStatus) {
  switch (status) {
    case 'open':
      return <Badge variant="default">open</Badge>;
    case 'awarded':
      return <Badge variant="secondary">awarded</Badge>;
    case 'in_review':
      return <Badge variant="outline">in review</Badge>;
    case 'completed':
      return <Badge variant="accent">completed</Badge>;
    case 'failed':
      return <Badge variant="destructive">failed</Badge>;
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
}

function termsText(terms: Bid['terms'] | undefined) {
  if (!terms) return '-';
  const pct = Math.round(terms.upfrontPct * 100);
  return `upfront ${pct}% · deadline ${terms.deadlineSeconds}s · revisions ${terms.maxRevisions}`;
}

function negotiationPill(status: string | undefined) {
  const s = (status ?? 'none').toLowerCase();
  if (s === 'pending') return <Badge variant="secondary">negotiating</Badge>;
  if (s === 'accept' || s === 'accepted') return <Badge variant="accent">accepted</Badge>;
  if (s === 'reject' || s === 'rejected') return <Badge variant="destructive">rejected</Badge>;
  if (s === 'max_rounds') return <Badge variant="destructive">max rounds</Badge>;
  if (s === 'none') return <Badge variant="outline">no negotiation</Badge>;
  return <Badge variant="outline">{s}</Badge>;
}

function negotiationSummary(job: Job): { status: string; round?: number; reason?: string } {
  const payload = job.payload ?? {};
  const n = (payload as any).negotiation as { status?: string; round?: number } | undefined;
  const acceptedTerms = (payload as any).acceptedTerms;

  const statusRaw = typeof n?.status === 'string' ? n.status : undefined;
  const round = typeof n?.round === 'number' ? n.round : undefined;

  // Accepted contracts may move quickly into awarded/completed; keep the win visible.
  if ((acceptedTerms && typeof acceptedTerms === 'object') || statusRaw === 'accept' || statusRaw === 'accepted') {
    return { status: 'accept', round, reason: 'contract accepted' };
  }

  if (statusRaw === 'pending') return { status: 'pending', round, reason: 'in progress' };
  if (statusRaw === 'reject' || statusRaw === 'rejected') return { status: 'reject', round, reason: 'worker rejected' };
  if (statusRaw === 'max_rounds') return { status: 'max_rounds', round, reason: 'max rounds reached' };
  return { status: 'none' };
}

function parseFirstInt(detail: string, key: string): number | null {
  const m = detail.match(new RegExp(`${key}=(-?\\\\d+)\\\\b`));
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function parseDecision(detail: string): 'accept' | 'reject' | null {
  const m = detail.match(/decision=(accept|reject)\b/);
  if (!m) return null;
  return m[1] === 'accept' ? 'accept' : 'reject';
}

export default function App() {
  const wsUrl = (import.meta.env.VITE_OBSERVER_WS as string | undefined) ?? defaultWsUrl();
  const [state, dispatch] = useReducer(reduce, {
    status: 'connecting',
    wsUrl,
    agents: {},
    baselineCredits: {},
    jobs: {},
    bids: {},
    evidence: [],
    tape: [],
    totalEvents: 0,
  } satisfies State);

  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const deepLinkJobId = useMemo(() => {
    try {
      const u = new URL(window.location.href);
      const v = u.searchParams.get('job');
      return v && v.trim().length > 0 ? v.trim() : null;
    } catch {
      return null;
    }
  }, []);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectRef = useRef<number | null>(null);

  useEffect(() => {
    const connect = () => {
      dispatch({ type: 'status', status: 'connecting' });
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.addEventListener('open', () => dispatch({ type: 'status', status: 'open' }));
      ws.addEventListener('close', () => {
        dispatch({ type: 'status', status: 'closed' });
        reconnectRef.current = window.setTimeout(connect, 800);
      });
      ws.addEventListener('error', () => {
        // Close triggers reconnect.
        try {
          ws.close();
        } catch {
          // ignore
        }
      });

      ws.addEventListener('message', (ev) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(String(ev.data));
        } catch {
          return;
        }
        if (!isObject(parsed) || typeof parsed.type !== 'string') return;
        const msg = parsed as SpectatorMsg;
        if (msg.type === 'snapshot') dispatch({ type: 'snapshot', snapshot: msg.data });
        if (msg.type === 'event') dispatch({ type: 'event', event: msg.data });
      });
    };

    connect();
    return () => {
      if (reconnectRef.current) window.clearTimeout(reconnectRef.current);
      wsRef.current?.close();
    };
  }, [wsUrl]);

  const agentsSorted = useMemo(() => {
    return Object.values(state.agents).sort((a, b) => b.credits - a.credits);
  }, [state.agents]);

  const highlights = useMemo(() => {
    const biggestUpfront = (() => {
      let best: { amount: number; jobId: string } | null = null;
      for (const ev of state.evidence) {
        if (ev.kind !== 'upfront') continue;
        const amount = parseFirstInt(ev.detail, 'paid_upfront');
        if (amount == null) continue;
        if (!best || amount > best.amount) best = { amount, jobId: ev.jobId };
      }
      return best;
    })();

    const hottestNegotiation = (() => {
      let best: { round: number; status: string; jobId: string } | null = null;
      for (const job of Object.values(state.jobs)) {
        const ns = negotiationSummary(job);
        const round = typeof ns.round === 'number' ? ns.round : 0;
        if (ns.status === 'none' || round <= 0) continue;
        if (!best || round > best.round) best = { round, status: ns.status, jobId: job.id };
      }
      return best;
    })();

    const topEarners = (() => {
      const rows = Object.values(state.agents).map((a) => {
        const base = state.baselineCredits[a.agentId] ?? a.credits;
        const delta = a.credits - base;
        return { agentId: a.agentId, agentName: a.agentName, delta, credits: a.credits };
      });
      rows.sort((a, b) => b.delta - a.delta);
      return rows.slice(0, 3);
    })();

    return { biggestUpfront, hottestNegotiation, topEarners };
  }, [state.agents, state.baselineCredits, state.evidence, state.jobs]);

  const jobsSorted = useMemo(() => {
    return Object.values(state.jobs).sort((a, b) => b.createdAtMs - a.createdAtMs);
  }, [state.jobs]);

  const bidsByJob = useMemo(() => {
    const map: Record<string, number> = {};
    for (const bid of Object.values(state.bids)) map[bid.jobId] = (map[bid.jobId] ?? 0) + 1;
    return map;
  }, [state.bids]);

  const selectedBids = useMemo(() => {
    if (!selectedJobId) return [];
    return Object.values(state.bids)
      .filter((b) => b.jobId === selectedJobId)
      .sort((a, b) => (b.bidderRep?.score ?? 0.5) - (a.bidderRep?.score ?? 0.5) || a.price - b.price);
  }, [selectedJobId, state.bids]);

  const openJobs = jobsSorted.filter((j) => j.status === 'open').length;
  const awardedJobs = jobsSorted.filter((j) => j.status === 'awarded').length;
  const completedJobs = jobsSorted.filter((j) => j.status === 'completed').length;
  const selectedJob = selectedJobId ? state.jobs[selectedJobId] : null;
  const selectedEvidence = useMemo(() => {
    if (!selectedJobId) return [];
    return state.evidence
      .filter((e) => e.jobId === selectedJobId)
      .sort((a, b) => b.atMs - a.atMs)
      .slice(0, 80);
  }, [selectedJobId, state.evidence]);

  const selectedNegotiation = useMemo(() => {
    const payload = selectedJob?.payload;
    if (!payload) return null;
    const raw = (payload as any).negotiation;
    if (!raw || typeof raw !== 'object') return null;
    const terms = (raw as any).terms;
    const historyRaw = (raw as any).history;
    return {
      workerId: String((raw as any).workerId ?? ''),
      bidId: typeof (raw as any).bidId === 'string' ? String((raw as any).bidId) : undefined,
      bidPrice: typeof (raw as any).bidPrice === 'number' ? Number((raw as any).bidPrice) : undefined,
      terms: terms && typeof terms === 'object' ? (terms as Bid['terms']) : undefined,
      notes: (raw as any).notes == null ? undefined : String((raw as any).notes),
      status: typeof (raw as any).status === 'string' ? String((raw as any).status) : 'pending',
      round: typeof (raw as any).round === 'number' ? Number((raw as any).round) : undefined,
      atMs: typeof (raw as any).atMs === 'number' ? Number((raw as any).atMs) : undefined,
      decidedAtMs: typeof (raw as any).decidedAtMs === 'number' ? Number((raw as any).decidedAtMs) : undefined,
      history: Array.isArray(historyRaw)
        ? historyRaw
            .filter((h) => h && typeof h === 'object')
            .map((h) => ({
              round: typeof (h as any).round === 'number' ? Number((h as any).round) : 0,
              fromRole: String((h as any).fromRole ?? '?'),
              terms: (h as any).terms as Bid['terms'],
              notes: (h as any).notes == null ? undefined : String((h as any).notes),
              atMs: typeof (h as any).atMs === 'number' ? Number((h as any).atMs) : Date.now(),
            }))
        : [],
    };
  }, [selectedJob?.payload]);

  const acceptedTerms = useMemo(() => {
    const payload = selectedJob?.payload;
    if (!payload) return undefined;
    const raw = (payload as any).acceptedTerms;
    if (!raw || typeof raw !== 'object') return undefined;
    return raw as Bid['terms'];
  }, [selectedJob?.payload]);

  useEffect(() => {
    if (!deepLinkJobId) return;
    if (selectedJobId) return;
    if (state.jobs[deepLinkJobId]) setSelectedJobId(deepLinkJobId);
  }, [deepLinkJobId, selectedJobId, state.jobs]);

  const runDemo = async () => {
    try {
      const res = await fetch('/api/demo/timeout', { method: 'POST' });
      const json = (await res.json()) as { ok: boolean; jobId?: string; error?: string };
      if (!json.ok || !json.jobId) throw new Error(json.error ?? 'demo_failed');
      const url = new URL(window.location.href);
      url.searchParams.set('job', json.jobId);
      window.history.replaceState(null, '', url.toString());
      setSelectedJobId(json.jobId);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(err);
      alert('Demo failed. Check the server logs.');
    }
  };

  return (
    <div className="min-h-screen">
      <header className="relative z-10 border-b bg-background/70 backdrop-blur-md">
        <div className="mx-auto max-w-7xl px-4 py-5 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-2xl bg-gradient-to-br from-primary to-accent shadow-[0_18px_60px_rgba(0,229,168,0.18)]" />
            <div className="leading-tight">
              <div className="text-[13px] font-semibold tracking-[0.22em]">SYNAPSE</div>
              <div className="text-xs font-mono text-muted-foreground">AI-to-AI Market (Live)</div>
            </div>
          </div>

          <div className="flex items-center gap-3 rounded-full border bg-card/50 px-4 py-2">
            <div
              className={cn(
                'h-2.5 w-2.5 rounded-full',
                state.status === 'open' && 'bg-primary shadow-[0_0_0_6px_rgba(0,229,168,0.14)]',
                state.status === 'connecting' &&
                  'bg-accent animate-pulse-soft shadow-[0_0_0_6px_rgba(255,209,102,0.14)]',
                state.status === 'closed' && 'bg-destructive shadow-[0_0_0_6px_rgba(255,71,111,0.14)]',
              )}
            />
            <div className="leading-tight">
              <div className="text-xs font-semibold">
                {state.status === 'open' ? 'Live' : state.status === 'connecting' ? 'Connecting' : 'Disconnected'}
              </div>
              <div className="text-[11px] font-mono text-muted-foreground">{state.wsUrl}</div>
            </div>
          </div>

          <button
            onClick={runDemo}
            className="rounded-full border bg-primary text-primary-foreground px-4 py-2 text-xs font-semibold shadow-[0_18px_60px_rgba(0,229,168,0.16)] hover:brightness-95"
          >
            Run demo
          </button>
        </div>
      </header>

      <main className="relative z-0 mx-auto max-w-7xl px-4 py-4">
        <div className="mb-4 grid gap-3 lg:grid-cols-12">
          <Card className="lg:col-span-6">
            <CardHeader>
              <CardTitle className="text-sm">What you are watching</CardTitle>
              <CardDescription className="text-xs">
                Contracts are posted, agents bid, one gets awarded, and settlement happens after verification (or timeout/failure).
                Click a contract to see its evidence timeline.
              </CardDescription>
            </CardHeader>
          </Card>
          <Card className="lg:col-span-3">
            <CardHeader>
              <CardTitle className="text-sm">Market state</CardTitle>
              <CardDescription className="text-xs font-mono">
                open={openJobs} · awarded={awardedJobs} · done={completedJobs} · agents={agentsSorted.length}
              </CardDescription>
            </CardHeader>
          </Card>
          <Card className="lg:col-span-3">
            <CardHeader>
              <CardTitle className="text-sm">Highlights (This Session)</CardTitle>
              <CardDescription className="text-xs">Fast signals worth clicking.</CardDescription>
            </CardHeader>
            <Separator />
            <CardContent className="pt-4 space-y-2 text-xs font-mono">
              <button
                className={cn(
                  'w-full text-left rounded-lg border bg-background/30 p-3 hover:bg-background/40',
                  !highlights.biggestUpfront && 'opacity-70 cursor-default hover:bg-background/30',
                )}
                onClick={() => {
                  if (!highlights.biggestUpfront) return;
                  setSelectedJobId(highlights.biggestUpfront.jobId);
                }}
              >
                <div className="flex items-baseline justify-between gap-3">
                  <div className="text-foreground/90 font-semibold">Biggest deposit</div>
                  <div className="text-accent font-semibold">
                    {highlights.biggestUpfront ? highlights.biggestUpfront.amount : '-'}
                  </div>
                </div>
                <div className="mt-1 text-[10px] text-muted-foreground">
                  {highlights.biggestUpfront ? `job ${shortId(highlights.biggestUpfront.jobId)}` : 'No upfront payments yet.'}
                </div>
              </button>

              <button
                className={cn(
                  'w-full text-left rounded-lg border bg-background/30 p-3 hover:bg-background/40',
                  !highlights.hottestNegotiation && 'opacity-70 cursor-default hover:bg-background/30',
                )}
                onClick={() => {
                  if (!highlights.hottestNegotiation) return;
                  setSelectedJobId(highlights.hottestNegotiation.jobId);
                }}
              >
                <div className="flex items-baseline justify-between gap-3">
                  <div className="text-foreground/90 font-semibold">Hottest negotiation</div>
                  <div className="flex items-center gap-2">
                    {highlights.hottestNegotiation ? negotiationPill(highlights.hottestNegotiation.status) : null}
                    <div className="text-[11px] font-mono text-muted-foreground">
                      {highlights.hottestNegotiation ? `r${highlights.hottestNegotiation.round}` : '-'}
                    </div>
                  </div>
                </div>
                <div className="mt-1 text-[10px] text-muted-foreground">
                  {highlights.hottestNegotiation
                    ? `job ${shortId(highlights.hottestNegotiation.jobId)}`
                    : 'No negotiations yet.'}
                </div>
              </button>

              <div className="rounded-lg border bg-background/30 p-3">
                <div className="text-foreground/90 font-semibold">Top earners</div>
                {highlights.topEarners.length === 0 ? (
                  <div className="mt-1 text-[10px] text-muted-foreground">No agents yet.</div>
                ) : (
                  <div className="mt-2 space-y-1.5">
                    {highlights.topEarners.map((r) => (
                      <div key={r.agentId} className="flex items-baseline justify-between gap-2">
                        <div className="truncate text-[11px] text-foreground/90">{r.agentName}</div>
                        <div className={cn('text-[11px] font-semibold', r.delta >= 0 ? 'text-primary' : 'text-destructive')}>
                          {r.delta >= 0 ? `+${r.delta}` : String(r.delta)}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                <div className="mt-2 text-[10px] text-muted-foreground">Delta since page load (approx).</div>
              </div>
            </CardContent>
          </Card>
        </div>
        <div className="grid gap-4 lg:grid-cols-12">
          <Card className="lg:col-span-5">
            <CardHeader>
              <div className="flex items-baseline justify-between gap-3">
                <CardTitle>Live Activity</CardTitle>
                <CardDescription>{state.totalEvents} events</CardDescription>
              </div>
            </CardHeader>
            <Separator />
            <CardContent className="pt-4">
              <div className="max-h-[70vh] overflow-auto space-y-2 pr-1">
                {state.tape.length === 0 ? (
                  <div className="text-sm text-muted-foreground font-mono">Waiting for events…</div>
                ) : (
                  state.tape.map((row) => {
                    const b = badgeForKind(row.kind);
                    return (
                      <div
                        key={row.id}
                        className={cn(
                          'animate-fade-up rounded-lg border bg-background/30 p-3',
                          'flex items-start gap-3',
                        )}
                      >
                        <div className="w-[70px] text-[11px] font-mono text-muted-foreground">
                          {formatTime(row.atMs)}
                        </div>
                        <div className="w-[84px]">
                          <Badge variant={b.variant}>{b.label}</Badge>
                        </div>
                        <div className="flex-1 text-xs font-mono leading-relaxed text-foreground/90">{row.detail}</div>
                      </div>
                    );
                  })
                )}
              </div>
            </CardContent>
          </Card>

          <Card className="lg:col-span-4">
            <CardHeader>
              <div className="flex items-baseline justify-between gap-3">
                <CardTitle>Jobs</CardTitle>
                <CardDescription>{openJobs} open</CardDescription>
              </div>
            </CardHeader>
            <Separator />
            <CardContent className="pt-4">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Status</TableHead>
                    <TableHead>Title</TableHead>
                    <TableHead className="text-right">Budget</TableHead>
                    <TableHead className="text-right">Bids</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {jobsSorted.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={4} className="text-muted-foreground">
                        No jobs yet.
                      </TableCell>
                    </TableRow>
                  ) : (
                    jobsSorted.slice(0, 18).map((job) => (
                      <TableRow
                        key={job.id}
                        className={cn('cursor-pointer', selectedJobId === job.id && 'bg-card/60')}
                        onClick={() => setSelectedJobId(job.id)}
                      >
                        <TableCell>{statusPill(job.status)}</TableCell>
                        <TableCell className="max-w-[220px]">
                          <div className="truncate text-foreground/90">{job.title}</div>
                          <div className="text-[10px] text-muted-foreground">
                            req {shortId(job.requesterId)} {job.workerId ? `· worker ${shortId(job.workerId)}` : ''}
                          </div>
                          {(() => {
                            const ns = negotiationSummary(job);
                            if (ns.status === 'none') return null;
                            return (
                              <div className="mt-1 flex items-center gap-2 text-[10px] font-mono">
                                {negotiationPill(ns.status)}
                                <span className="text-muted-foreground">
                                  {typeof ns.round === 'number' && ns.round > 0 ? `r${ns.round}` : ''}
                                  {ns.reason ? `${typeof ns.round === 'number' && ns.round > 0 ? ' · ' : ''}${ns.reason}` : ''}
                                </span>
                              </div>
                            );
                          })()}
                        </TableCell>
                        <TableCell className="text-right text-accent font-semibold">{job.budget}</TableCell>
                        <TableCell className="text-right">{bidsByJob[job.id] ?? 0}</TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          <Card className="lg:col-span-3">
            <CardHeader>
              <div className="flex items-baseline justify-between gap-3">
                <CardTitle>Agents (Wallet + Reputation)</CardTitle>
                <CardDescription>{agentsSorted.length} connected</CardDescription>
              </div>
            </CardHeader>
            <Separator />
            <CardContent className="pt-4">
              <div className="space-y-2">
                {agentsSorted.length === 0 ? (
                  <div className="text-sm text-muted-foreground font-mono">No agents.</div>
                ) : (
                  agentsSorted.map((a, idx) => (
                    <div key={a.agentId} className="rounded-lg border bg-background/30 p-3 flex items-center gap-3">
                      <div className="h-9 w-9 rounded-xl border bg-card/30 grid place-items-center font-mono text-xs">
                        {idx + 1}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline justify-between gap-2">
                          <div className="truncate font-mono text-xs text-foreground/90">{a.agentName}</div>
                          <div className="font-mono text-xs font-semibold text-primary">{a.credits}</div>
                        </div>
                        <div className="text-[10px] font-mono text-muted-foreground">
                          id {shortId(a.agentId)} · locked {a.locked} · rep {Math.round((a.rep?.score ?? 0.5) * 100)}%
                          <span className="text-muted-foreground/70">
                            {' '}
                            ({a.rep?.completed ?? 0} ok / {a.rep?.failed ?? 0} fail)
                          </span>
                        </div>
                        <div className="mt-2 h-1.5 w-full rounded-full bg-muted/60 overflow-hidden">
                          <div
                            className="h-full rounded-full bg-gradient-to-r from-primary to-accent"
                            style={{
                              width: `${Math.max(
                                6,
                                Math.min(100, (a.credits / Math.max(agentsSorted[0]?.credits ?? 1, 1)) * 100),
                              )}%`,
                            }}
                          />
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      </main>

      {selectedJob ? (
        <div
          className="fixed inset-0 z-50 bg-background/70 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          onClick={() => setSelectedJobId(null)}
        >
          <div className="mx-auto max-w-3xl px-4 pt-10" onClick={(e) => e.stopPropagation()}>
            <Card>
              <CardHeader>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <CardTitle className="truncate">{selectedJob.title}</CardTitle>
                    <CardDescription className="font-mono text-[11px]">
                      id {shortId(selectedJob.id)} · kind {String(selectedJob.kind ?? 'simple')}
                    </CardDescription>
                  </div>
                  <button
                    className="text-xs font-mono text-muted-foreground hover:text-foreground border rounded-md px-2 py-1"
                    onClick={() => setSelectedJobId(null)}
                  >
                    close
                  </button>
                </div>
              </CardHeader>
              <Separator />
              <CardContent className="pt-4 space-y-3">
                <div className="grid grid-cols-2 gap-3 text-xs font-mono">
                  <div className="rounded-lg border bg-background/30 p-3">
                    <div className="text-muted-foreground">requester</div>
                    <div className="mt-1">{shortId(selectedJob.requesterId)}</div>
                  </div>
                  <div className="rounded-lg border bg-background/30 p-3">
                    <div className="text-muted-foreground">worker</div>
                    <div className="mt-1">{selectedJob.workerId ? shortId(selectedJob.workerId) : '-'}</div>
                  </div>
                  <div className="rounded-lg border bg-background/30 p-3">
                    <div className="text-muted-foreground">budget</div>
                    <div className="mt-1 text-accent font-semibold">{selectedJob.budget}</div>
                  </div>
                  <div className="rounded-lg border bg-background/30 p-3">
                    <div className="text-muted-foreground">status</div>
                    <div className="mt-1">{selectedJob.status}</div>
                  </div>
                </div>

                <div className="grid lg:grid-cols-2 gap-3">
                  <div>
                    <div className="text-xs font-semibold">Applicants</div>
                    <div className="mt-2 rounded-lg border bg-background/30 p-3">
                      {selectedBids.length === 0 ? (
                        <div className="text-xs font-mono text-muted-foreground">No bids yet.</div>
                      ) : (
                        <div className="space-y-2">
                          {selectedBids.slice(0, 8).map((b) => (
                            <div key={b.id} className="rounded-md border bg-background/40 p-2">
                              <div className="flex items-baseline justify-between gap-2 text-xs font-mono">
                                <div className="text-foreground/90">worker {shortId(b.bidderId)}</div>
                                <div className="text-muted-foreground">
                                  rep {Math.round(((b.bidderRep?.score ?? 0.5) as number) * 100)}% · price {b.price} · eta{' '}
                                  {b.etaSeconds}s
                                </div>
                              </div>
                              {b.terms ? (
                                <div className="mt-1 text-[11px] text-muted-foreground">terms {termsText(b.terms)}</div>
                              ) : null}
                              {b.pitch ? <div className="mt-1 text-[11px] text-muted-foreground">{b.pitch}</div> : null}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>

                  <div>
                    <div className="flex items-baseline justify-between gap-3">
                      <div className="text-xs font-semibold">Negotiation / Contract</div>
                      {negotiationPill(selectedNegotiation?.status)}
                    </div>
                    <div className="mt-2 rounded-lg border bg-background/30 p-3">
                      {(() => {
                        const n = selectedNegotiation;
                        const offerEv = selectedEvidence.find((e) => e.kind === 'offer');
                        const respEv = selectedEvidence.find((e) => e.kind === 'offer_response');
                        const upfrontEv = selectedEvidence.find((e) => e.kind === 'upfront');

                        const bid =
                          (n?.bidId ? selectedBids.find((b) => b.id === n.bidId) : null) ??
                          (n?.workerId ? selectedBids.find((b) => b.bidderId === n.workerId) : null) ??
                          (selectedJob?.workerId ? selectedBids.find((b) => b.bidderId === selectedJob.workerId) : null) ??
                          (selectedBids[0] ?? null);

                        const decision = respEv ? parseDecision(respEv.detail) : null;

                        const transcript = [...(n?.history ?? [])].sort((a, b) => a.atMs - b.atMs);

                        const cards: Array<{ k: string; title: string; atMs?: number; body: React.ReactNode }> = [];

                        cards.push({
                          k: 'bid',
                          title: 'Worker proposal (bid)',
                          atMs: bid?.createdAtMs,
                          body: bid ? (
                            <div className="space-y-1">
                              <div className="text-foreground/90">
                                worker {shortId(bid.bidderId)} · price {bid.price} · eta {bid.etaSeconds}s
                              </div>
                              <div className="text-muted-foreground">terms {termsText(bid.terms)}</div>
                              {bid.pitch ? <div className="text-muted-foreground">{bid.pitch}</div> : null}
                            </div>
                          ) : (
                            <div className="text-muted-foreground">No bid yet.</div>
                          ),
                        });

                        cards.push({
                          k: 'transcript',
                          title: 'Negotiation transcript',
                          atMs: undefined,
                          body:
                            transcript.length === 0 ? (
                              <div className="text-muted-foreground">
                                {offerEv ? offerEv.detail : 'No negotiation yet.'}
                              </div>
                            ) : (
                              <div className="space-y-2">
                                {transcript.map((h, idx) => (
                                  <div key={`${h.atMs}-${idx}`} className="rounded-md border bg-background/30 p-2">
                                    <div className="flex items-baseline justify-between gap-2">
                                      <div className="text-foreground/90 font-semibold">
                                        r{h.round} · {h.fromRole === 'boss' ? 'boss' : 'worker'}
                                      </div>
                                      <div className="text-muted-foreground">{formatTime(h.atMs)}</div>
                                    </div>
                                    <div className="mt-1 text-muted-foreground">terms {termsText(h.terms)}</div>
                                    {h.notes ? <div className="mt-1 text-muted-foreground">{h.notes}</div> : null}
                                  </div>
                                ))}
                              </div>
                            ),
                        });

                        cards.push({
                          k: 'decision',
                          title: 'Worker decision',
                          atMs: respEv?.atMs ?? n?.decidedAtMs,
                          body: respEv ? (
                            <div className="text-foreground/90">
                              {decision ? negotiationPill(decision) : null} <span className="ml-2">{respEv.detail}</span>
                            </div>
                          ) : n?.status && n.status !== 'pending' ? (
                            <div className="text-foreground/90">{negotiationPill(n.status)}</div>
                          ) : (
                            <div className="text-muted-foreground">Waiting…</div>
                          ),
                        });

                        if (acceptedTerms) {
                          cards.push({
                            k: 'contract',
                            title: 'Contract terms (accepted)',
                            atMs: undefined,
                            body: <div className="text-muted-foreground">terms {termsText(acceptedTerms)}</div>,
                          });
                        }

                        if (upfrontEv) {
                          cards.push({
                            k: 'upfront',
                            title: 'Upfront (deposit)',
                            atMs: upfrontEv.atMs,
                            body: <div className="text-muted-foreground">{upfrontEv.detail}</div>,
                          });
                        }

                        return (
                          <div className="space-y-2 text-[11px] font-mono">
                            {cards.map((c) => (
                              <div key={c.k} className="rounded-md border bg-background/40 p-2">
                                <div className="flex items-baseline justify-between gap-2">
                                  <div className="text-foreground/90 font-semibold">{c.title}</div>
                                  {c.atMs ? <div className="text-muted-foreground">{formatTime(c.atMs)}</div> : null}
                                </div>
                                <div className="mt-1">{c.body}</div>
                              </div>
                            ))}
                          </div>
                        );
                      })()}
                    </div>
                  </div>
                </div>

                <div>
                  <div className="text-xs font-semibold">Evidence</div>
                  <div className="mt-2 rounded-lg border bg-background/30 p-3 max-h-[320px] overflow-auto">
                    {selectedEvidence.length === 0 ? (
                      <div className="text-xs font-mono text-muted-foreground">No evidence yet.</div>
                    ) : (
                      <div className="space-y-2">
                        {selectedEvidence.map((ev) => (
                          <div key={ev.id} className="text-xs font-mono">
                            <span className="text-muted-foreground">{new Date(ev.atMs).toLocaleString()} </span>
                            <span className="text-accent">{ev.kind}</span>
                            <span className="text-muted-foreground"> · </span>
                            <span className="text-foreground/90">{ev.detail}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      ) : null}

      <footer className="relative z-0 mx-auto max-w-7xl px-4 pb-6 text-[11px] font-mono text-muted-foreground flex items-center justify-between">
        <div>Phase 2 · Spectator Mode</div>
        <div>Protocol v1</div>
      </footer>
    </div>
  );
}

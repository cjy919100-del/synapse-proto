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
type JobStatus = 'open' | 'awarded' | 'completed' | 'cancelled';
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

      return { ...state, agents, jobs, bids, evidence: action.snapshot.evidence ?? [] };
    }
    case 'event': {
      const next: State = {
        ...state,
        agents: { ...state.agents },
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
        next.agents[action.event.agentId] = {
          agentId: action.event.agentId,
          agentName: action.event.agentName,
          credits: action.event.credits,
          locked: prev?.locked ?? 0,
          rep: prev?.rep ?? { completed: 0, failed: 0, score: 0.5 },
        };
      } else if (action.event.type === 'ledger_update') {
        const prev = next.agents[action.event.agentId];
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
          if (msg.type === 'job_completed' && typeof msg.jobId === 'string') {
            const prev = next.jobs[msg.jobId];
            if (prev) next.jobs[msg.jobId] = { ...prev, status: 'completed' };
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
    case 'completed':
      return <Badge variant="accent">completed</Badge>;
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
}

export default function App() {
  const wsUrl = (import.meta.env.VITE_OBSERVER_WS as string | undefined) ?? defaultWsUrl();
  const [state, dispatch] = useReducer(reduce, {
    status: 'connecting',
    wsUrl,
    agents: {},
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

  const jobsSorted = useMemo(() => {
    return Object.values(state.jobs).sort((a, b) => b.createdAtMs - a.createdAtMs);
  }, [state.jobs]);

  const bidsByJob = useMemo(() => {
    const map: Record<string, number> = {};
    for (const bid of Object.values(state.bids)) map[bid.jobId] = (map[bid.jobId] ?? 0) + 1;
    return map;
  }, [state.bids]);

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
          <Card className="lg:col-span-8">
            <CardHeader>
              <CardTitle className="text-sm">What you are watching</CardTitle>
              <CardDescription className="text-xs">
                Contracts are posted, agents bid, one gets awarded, and settlement happens after verification (or timeout/failure).
                Click a contract to see its evidence timeline.
              </CardDescription>
            </CardHeader>
          </Card>
          <Card className="lg:col-span-4">
            <CardHeader>
              <CardTitle className="text-sm">Market state</CardTitle>
              <CardDescription className="text-xs font-mono">
                open={openJobs} · awarded={awardedJobs} · done={completedJobs} · agents={agentsSorted.length}
              </CardDescription>
            </CardHeader>
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

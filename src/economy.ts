import 'dotenv/config';
import { readFile } from 'node:fs/promises';

import { SynapseDb } from './db.js';
import { EconomyAgent, type RealJobSeed } from './economy_agent.js';
import { CoreServer } from './server.js';
import { SpectatorServer } from './spectator.js';

const corePort = Number(process.env.SYNAPSE_PORT ?? 8787);
const spectatorPort = Number(process.env.SYNAPSE_SPECTATOR_PORT ?? 8790);
const coreUrl = `ws://localhost:${corePort}`;

function parseBoolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw) return fallback;
  const v = raw.trim().toLowerCase();
  if (v === '1' || v === 'true' || v === 'yes' || v === 'on') return true;
  if (v === '0' || v === 'false' || v === 'no' || v === 'off') return false;
  return fallback;
}

async function loadBacklog(path: string | undefined): Promise<RealJobSeed[]> {
  if (!path) return [];
  const raw = await readFile(path, 'utf8');
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) throw new Error('SYNAPSE_JOB_SOURCE_FILE must be a JSON array');

  const out: RealJobSeed[] = [];
  for (const row of parsed) {
    if (!row || typeof row !== 'object') continue;
    const title = typeof (row as any).title === 'string' ? (row as any).title.trim() : '';
    const budget = Number((row as any).budget);
    if (!title || !Number.isFinite(budget) || budget <= 0) continue;
    out.push({
      title,
      description: typeof (row as any).description === 'string' ? (row as any).description : undefined,
      budget: Math.floor(budget),
      kind: typeof (row as any).kind === 'string' ? (row as any).kind : undefined,
      payload: (row as any).payload && typeof (row as any).payload === 'object' ? ((row as any).payload as Record<string, unknown>) : undefined,
    });
  }
  return out;
}

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  const db = dbUrl ? new SynapseDb({ connectionString: dbUrl }) : undefined;
  if (db) await db.ensureSchema();

  // eslint-disable-next-line no-console
  console.log(`[economy] core ws: ${coreUrl}`);
  const core = new CoreServer(corePort, { db });
  const spectator = new SpectatorServer({ port: spectatorPort, core });

  const n = Number(process.env.SYNAPSE_ECO_AGENTS ?? 8);
  const backlogPath = process.env.SYNAPSE_JOB_SOURCE_FILE;
  const backlog = await loadBacklog(backlogPath);
  const syntheticFallback = parseBoolEnv('SYNAPSE_SYNTHETIC_FALLBACK', true);
  const backlogByAgent: RealJobSeed[][] = Array.from({ length: n }, () => []);
  backlog.forEach((job, i) => {
    backlogByAgent[i % n]!.push(job);
  });

  if (backlog.length > 0) {
    // eslint-disable-next-line no-console
    console.log(
      `[economy] loaded ${backlog.length} real jobs from ${backlogPath}${syntheticFallback ? ' (synthetic fallback on)' : ' (synthetic fallback off)'}`,
    );
  }

  const agents: EconomyAgent[] = [];
  for (let i = 0; i < n; i += 1) {
    agents.push(
      new EconomyAgent({
        name: `agent-${i + 1}`,
        url: coreUrl,
        canBoss: true,
        canWork: true,
        maxOpenJobs: 1,
        backlogJobs: backlogByAgent[i]!,
        syntheticFallback,
      }),
    );
  }

  process.on('SIGINT', async () => {
    // eslint-disable-next-line no-console
    console.log('\\n[economy] shutting down...');
    for (const a of agents) a.close();
    await spectator.close();
    await core.close();
    if (db) await db.close();
    process.exit(0);
  });
}

void main();

import 'dotenv/config';

import { SynapseDb } from './db.js';
import { EconomyAgent } from './economy_agent.js';
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

function randomInt(maxExclusive: number): number {
  return Math.floor(Math.random() * maxExclusive);
}

function generateAgentName(existing: Set<string>): string {
  const prefixes = ['swift', 'silent', 'lucky', 'steady', 'keen', 'brisk', 'alpha', 'nova', 'clear', 'prime'];
  const roles = ['broker', 'worker', 'maker', 'builder', 'solver', 'pilot', 'trader', 'ranger', 'smith', 'forge'];

  for (let i = 0; i < 100; i += 1) {
    const name = `${prefixes[randomInt(prefixes.length)]}-${roles[randomInt(roles.length)]}-${100 + randomInt(900)}`;
    if (!existing.has(name)) return name;
  }

  const fallback = `agent-${Date.now()}-${100 + randomInt(900)}`;
  if (!existing.has(fallback)) return fallback;
  return `agent-${Date.now()}-${1000 + randomInt(9000)}`;
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
  const autoPostJobs = parseBoolEnv('SYNAPSE_AGENT_AUTO_POST', false);
  // eslint-disable-next-line no-console
  console.log(`[economy] synthetic auto-post: ${autoPostJobs ? 'on' : 'off'}`);

  const agents: EconomyAgent[] = [];
  const usedNames = new Set<string>();
  for (let i = 0; i < n; i += 1) {
    const name = generateAgentName(usedNames);
    usedNames.add(name);
    agents.push(
      new EconomyAgent({
        name,
        url: coreUrl,
        canBoss: true,
        canWork: true,
        maxOpenJobs: 1,
        autoPostJobs,
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

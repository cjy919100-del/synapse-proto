import 'dotenv/config';

import { SynapseDb } from './db.js';
import { CoreServer } from './server.js';
import { FakeAgent } from './agent.js';
import { SpectatorServer } from './spectator.js';
import { GithubWebhookServer } from './github/webhook_server.js';

const corePort = Number(process.env.SYNAPSE_PORT ?? 8787);
const spectatorPort = Number(process.env.SYNAPSE_SPECTATOR_PORT ?? 8790);
const githubWebhookPort = Number(process.env.SYNAPSE_GH_WEBHOOK_PORT ?? 8791);
const githubWebhookSecret = process.env.GITHUB_WEBHOOK_SECRET;
const githubPayOn = (process.env.SYNAPSE_GH_PAY_ON as 'checks_success' | 'merge' | undefined) ?? 'checks_success';

const coreUrl = `ws://localhost:${corePort}`;

function randomInt(maxExclusive: number): number {
  return Math.floor(Math.random() * maxExclusive);
}

function parseBoolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw) return fallback;
  const v = raw.trim().toLowerCase();
  if (v === '1' || v === 'true' || v === 'yes' || v === 'on') return true;
  if (v === '0' || v === 'false' || v === 'no' || v === 'off') return false;
  return fallback;
}

function generateAgentName(existing: Set<string>): string {
  const prefixes = ['swift', 'silent', 'lucky', 'steady', 'keen', 'brisk', 'alpha', 'nova', 'clear', 'prime'];
  const roles = ['boss', 'worker', 'maker', 'builder', 'solver', 'pilot', 'trader', 'ranger', 'smith', 'forge'];
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
  if (db) {
    await db.ensureSchema();
    // eslint-disable-next-line no-console
    console.log('[dev] DB enabled');
  } else {
    // eslint-disable-next-line no-console
    console.log('[dev] DB disabled (set DATABASE_URL to enable)');
  }

  // eslint-disable-next-line no-console
  console.log(`[dev] core ws: ${coreUrl}`);
  const core = new CoreServer(corePort, { db });
  const spectator = new SpectatorServer({ port: spectatorPort, core });
  const gh = new GithubWebhookServer(core, { port: githubWebhookPort, secret: githubWebhookSecret, payOn: githubPayOn });
  gh.listen();

  const fakeAgents: FakeAgent[] = [];
  const spawnFakeAgents = parseBoolEnv('SYNAPSE_DEV_FAKE_AGENTS', false);
  if (spawnFakeAgents) {
    const usedNames = new Set<string>();
    const requesterName = generateAgentName(usedNames);
    usedNames.add(requesterName);
    const workerNameA = generateAgentName(usedNames);
    usedNames.add(workerNameA);
    const workerNameB = generateAgentName(usedNames);
    usedNames.add(workerNameB);
    const workerNameC = generateAgentName(usedNames);
    usedNames.add(workerNameC);

    fakeAgents.push(new FakeAgent({ name: requesterName, role: 'requester', url: coreUrl }));
    fakeAgents.push(new FakeAgent({ name: workerNameA, role: 'worker', url: coreUrl }));
    fakeAgents.push(new FakeAgent({ name: workerNameB, role: 'worker', url: coreUrl }));
    fakeAgents.push(new FakeAgent({ name: workerNameC, role: 'worker', url: coreUrl }));
    // eslint-disable-next-line no-console
    console.log('[dev] fake agents: on');
  } else {
    // eslint-disable-next-line no-console
    console.log('[dev] fake agents: off');
  }

  process.on('SIGINT', async () => {
    // eslint-disable-next-line no-console
    console.log('\\n[dev] shutting down...');
    for (const a of fakeAgents) a.close();
    await spectator.close();
    await gh.close();
    await core.close();
    if (db) await db.close();
    process.exit(0);
  });
}

void main();

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

  // Seed a tiny market so the dashboard immediately has motion.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const requester = new FakeAgent({ name: 'requester-1', role: 'requester', url: coreUrl });
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const workerA = new FakeAgent({ name: 'worker-a', role: 'worker', url: coreUrl });
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const workerB = new FakeAgent({ name: 'worker-b', role: 'worker', url: coreUrl });
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const workerC = new FakeAgent({ name: 'worker-c', role: 'worker', url: coreUrl });

  process.on('SIGINT', async () => {
    // eslint-disable-next-line no-console
    console.log('\\n[dev] shutting down...');
    await spectator.close();
    await gh.close();
    await core.close();
    if (db) await db.close();
    process.exit(0);
  });
}

void main();

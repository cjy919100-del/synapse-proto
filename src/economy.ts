import 'dotenv/config';

import { SynapseDb } from './db.js';
import { EconomyAgent } from './economy_agent.js';
import { CoreServer } from './server.js';
import { SpectatorServer } from './spectator.js';

const corePort = Number(process.env.SYNAPSE_PORT ?? 8787);
const spectatorPort = Number(process.env.SYNAPSE_SPECTATOR_PORT ?? 8790);
const coreUrl = `ws://localhost:${corePort}`;

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  const db = dbUrl ? new SynapseDb({ connectionString: dbUrl }) : undefined;
  if (db) await db.ensureSchema();

  // eslint-disable-next-line no-console
  console.log(`[economy] core ws: ${coreUrl}`);
  const core = new CoreServer(corePort, { db });
  const spectator = new SpectatorServer({ port: spectatorPort, core });

  const n = Number(process.env.SYNAPSE_ECO_AGENTS ?? 8);
  const agents: EconomyAgent[] = [];
  for (let i = 0; i < n; i += 1) {
    agents.push(
      new EconomyAgent({
        name: `agent-${i + 1}`,
        url: coreUrl,
        canBoss: true,
        canWork: true,
        maxOpenJobs: 1,
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


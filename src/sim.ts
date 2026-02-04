import { CoreServer } from './server.js';
import { FakeAgent } from './agent.js';

const port = Number(process.env.SYNAPSE_PORT ?? 8787);
const url = `ws://localhost:${port}`;

// eslint-disable-next-line no-console
console.log(`[sim] starting server on ${url}`);
const server = new CoreServer(port);

// Spin up a tiny market: 1 requester, 3 workers.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const requester = new FakeAgent({ name: 'requester-1', role: 'requester', url });
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const workerA = new FakeAgent({ name: 'worker-a', role: 'worker', url });
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const workerB = new FakeAgent({ name: 'worker-b', role: 'worker', url });
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const workerC = new FakeAgent({ name: 'worker-c', role: 'worker', url });

process.on('SIGINT', async () => {
  // eslint-disable-next-line no-console
  console.log('\\n[sim] shutting down...');
  await server.close();
  process.exit(0);
});

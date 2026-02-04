process.env.FORCE_MOCK_LLM = 'true';
import { CoreServer } from '../src/server.js';
import { FakeAgent } from '../src/agent.js';
import { PROTOCOL_VERSION, type AgentToServerMsg, type ServerToAgentMsg } from '../src/protocol.js';

const PORT = 9006;
const WS_URL = `ws://localhost:${PORT}`;

async function run() {
    console.log('--- Starting Verification Script ---');
    const server = new CoreServer(PORT);

    // Wait for server
    await new Promise(r => setTimeout(r, 100));

    const requester = new FakeAgent({ name: 'requester', role: 'requester', url: WS_URL, autoLoop: false });
    const worker = new FakeAgent({ name: 'worker', role: 'worker', url: WS_URL });

    // Wait for auth
    await new Promise(r => setTimeout(r, 1000));

    console.log('--- Agents Connected ---');

    // Post coding job
    const payload = {
        description: 'return square of input',
        template: 'function solve(x) { ... }',
        tests: [
            { input: 2, expected: 4 },
            { input: 10, expected: 100 },
        ],
    };

    const postMsg: AgentToServerMsg = {
        v: PROTOCOL_VERSION,
        type: 'post_job',
        title: 'coding challenge',
        budget: 50,
        kind: 'coding',
        payload,
    };

    // Hack access to send
    (requester as any).send(postMsg);
    console.log('--- Job Posted ---');

    // Listen for completion
    return new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
            reject(new Error('Timeout waiting for completion'));
        }, 5000);

        server.on('tape', (evt) => {
            if (evt.type === 'broadcast') {
                const msg = evt.msg;
                if (msg.type === 'job_completed') {
                    if (msg.jobId && msg.paid === 50) {
                        console.log('SUCCESS: Job completed and paid 50');
                        clearTimeout(timeout);
                        requester.close();
                        worker.close();
                        server.close().then(resolve);
                    }
                }
                if (msg.type === 'job_failed') {
                    console.error('FAILURE: Job failed', msg.reason);
                    clearTimeout(timeout);
                    requester.close();
                    worker.close();
                    server.close().then(() => reject(new Error(msg.reason)));
                }
            }
        });
    });
}

run().catch(err => {
    console.error('Verification Failed:', err);
    process.exit(1);
});

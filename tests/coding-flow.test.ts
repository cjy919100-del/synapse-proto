import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { CoreServer } from '../src/server.js';
import { FakeAgent } from '../src/agent.js';
import { PROTOCOL_VERSION, type AgentToServerMsg, type JobCompletedMsg, type JobFailedMsg, type ServerToAgentMsg } from '../src/protocol.js';

const PORT = 9005;
const WS_URL = `ws://localhost:${PORT}`;

describe('coding task flow: post_job -> solve -> evaluate -> pay', () => {
    let server: CoreServer;
    let requester: FakeAgent;
    let worker: FakeAgent;

    beforeAll(async () => {
        // Deterministic test: never hit real network/LLM.
        process.env.FORCE_MOCK_LLM = 'true';

        server = new CoreServer(PORT);
        // Give server a moment to listen
        await new Promise((r) => setTimeout(r, 100));

        requester = new FakeAgent({ name: 'requester', role: 'requester', url: WS_URL, autoLoop: false });
        worker = new FakeAgent({ name: 'worker', role: 'worker', url: WS_URL });

        // Wait for auth
        await new Promise((r) => setTimeout(r, 500));
    });

    afterAll(async () => {
        requester.close();
        worker.close();
        await server.close();
    });

    it('successfully completes a coding task', async () => {
        return new Promise<void>((resolve, reject) => {
            // 1. Requester posts a Job with 'coding' kind
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

            // We need to inject this into the specific test flow because FakeAgent's default startRequesterLoop 
            // posts simple tasks. We'll manually send this one.
            // Accessing private 'send' via 'any' or just sending raw ws message?
            // FakeAgent doesn't expose send. Let's hack it for test or add public method.
            // Actually FakeAgent has 'startRequesterLoop'. We can just modify FakeAgent logic OR 
            // rely on the fact that we can't easily trigger it from outside without modifying code?
            // Wait, FakeAgent is a class I just wrote. I can add a method `postJob` to it.
            // OR I can interact with the WebSocket directly for the test, pretending to be the agent.
            // But I am using FakeAgent instance.

            // Let's modify FakeAgent to allow manual posting or just use 'any' cast.
            (requester as any).send(postMsg);

            // Listen for completion on server tape or agent logs?
            // Server emits 'tape' events.
            server.on('tape', (evt) => {
                if (evt.type === 'broadcast') {
                    const msg = evt.msg;
                    if (msg.type === 'job_completed') {
                        try {
                            expect(msg.paid).toBe(50);
                            expect(msg.workerId).toBeDefined();
                            resolve();
                        } catch (err) {
                            reject(err);
                        }
                    }
                    if (msg.type === 'job_failed') {
                        reject(new Error(`Job failed: ${msg.reason}`));
                    }
                }
            });
        });
    }, 10_000);
});

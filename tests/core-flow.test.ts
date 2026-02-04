import WebSocket from 'ws';
import { afterAll, beforeAll, expect, test } from 'vitest';

import { generateEd25519KeyPair, signAuth } from '../src/crypto.js';
import { PROTOCOL_VERSION } from '../src/protocol.js';
import { CoreServer } from '../src/server.js';

type AnyMsg = Record<string, unknown> & { type: string; v: number };

function waitFor(ws: WebSocket, predicate: (msg: AnyMsg) => boolean, timeoutMs = 2_500): Promise<AnyMsg> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      cleanup();
      reject(new Error('timeout'));
    }, timeoutMs);

    const onMessage = (raw: WebSocket.RawData) => {
      let msg: unknown;
      try {
        msg = JSON.parse(raw.toString('utf8'));
      } catch {
        return;
      }
      if (!msg || typeof msg !== 'object') return;
      const m = msg as AnyMsg;
      if (m.v !== PROTOCOL_VERSION || typeof m.type !== 'string') return;
      if (!predicate(m)) return;
      cleanup();
      resolve(m);
    };

    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };

    const cleanup = () => {
      clearTimeout(t);
      ws.off('message', onMessage);
      ws.off('error', onError);
    };

    ws.on('message', onMessage);
    ws.on('error', onError);
  });
}

async function connectAuthed(url: string, agentName: string) {
  const keyPair = generateEd25519KeyPair();
  const ws = new WebSocket(url);

  const challenge = await waitFor(ws, (m) => m.type === 'challenge');
  const nonce = String(challenge.nonce);

  const signature = signAuth({
    nonceB64: nonce,
    agentName,
    publicKeyDerB64: keyPair.publicKeyDerB64,
    privateKey: keyPair.privateKey,
  });

  ws.send(
    JSON.stringify({
      v: PROTOCOL_VERSION,
      type: 'auth',
      agentName,
      publicKey: keyPair.publicKeyDerB64,
      signature,
      nonce,
    }),
  );

  const authed = await waitFor(ws, (m) => m.type === 'authed');
  return { ws, agentId: String(authed.agentId), credits: Number(authed.credits) };
}

let server: CoreServer;
let url: string;

beforeAll(() => {
  server = new CoreServer(0);
  url = `ws://127.0.0.1:${server.getListeningPort()}`;
});

afterAll(async () => {
  await server.close();
});

test('market loop: post_job -> bid -> award -> submit -> settle', async () => {
  const requester = await connectAuthed(url, 'requester');
  const worker = await connectAuthed(url, 'worker');

  // requester posts job
  requester.ws.send(
    JSON.stringify({
      v: PROTOCOL_VERSION,
      type: 'post_job',
      title: 'task: login page',
      budget: 25,
    }),
  );

  const jobPosted = await waitFor(requester.ws, (m) => m.type === 'job_posted');
  const jobId = String((jobPosted as any).job.id);

  // worker bids
  worker.ws.send(
    JSON.stringify({
      v: PROTOCOL_VERSION,
      type: 'bid',
      jobId,
      price: 10,
      etaSeconds: 2,
    }),
  );

  const bidPosted = await waitFor(requester.ws, (m) => m.type === 'bid_posted');
  const workerId = String((bidPosted as any).bid.bidderId);

  // requester awards
  requester.ws.send(
    JSON.stringify({
      v: PROTOCOL_VERSION,
      type: 'award',
      jobId,
      workerId,
    }),
  );

  await waitFor(worker.ws, (m) => m.type === 'job_awarded' && String((m as any).jobId) === jobId);

  // Start waits before submitting so we don't miss fast broadcasts.
  const pCompleted = waitFor(
    requester.ws,
    (m) => m.type === 'job_completed' && String((m as any).jobId) === jobId,
  );
  const pRequesterLedger = waitFor(requester.ws, (m) => m.type === 'ledger_update');
  const pWorkerLedger = waitFor(worker.ws, (m) => m.type === 'ledger_update');

  // worker submits
  worker.ws.send(JSON.stringify({ v: PROTOCOL_VERSION, type: 'submit', jobId, result: 'done' }));

  const [completed, requesterLedger, workerLedger] = await Promise.all([
    pCompleted,
    pRequesterLedger,
    pWorkerLedger,
  ]);
  expect(Number((completed as any).paid)).toBe(25);

  // ledger updates should reflect 25 paid from requester -> worker
  expect(Number(requesterLedger.credits)).toBe(requester.credits - 25);
  expect(Number(workerLedger.credits)).toBe(worker.credits + 25);

  requester.ws.close();
  worker.ws.close();
});

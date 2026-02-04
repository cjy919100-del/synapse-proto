import { afterAll, beforeAll, expect, test } from 'vitest';

import { SynapseDb } from '../src/db.js';
import { CoreServer } from '../src/server.js';

import WebSocket from 'ws';
import { generateEd25519KeyPair, signAuth } from '../src/crypto.js';
import { PROTOCOL_VERSION } from '../src/protocol.js';

type AnyMsg = Record<string, unknown> & { type: string; v: number };

function waitFor(ws: WebSocket, predicate: (msg: AnyMsg) => boolean, timeoutMs = 3_500): Promise<AnyMsg> {
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

const dbUrl = process.env.DATABASE_URL;

let db: SynapseDb | undefined;
let server: CoreServer | undefined;
let url: string | undefined;

beforeAll(async () => {
  if (!dbUrl) return;
  db = new SynapseDb({ connectionString: dbUrl });
  await db.ensureSchema();
  server = new CoreServer(0, { db });
  url = `ws://127.0.0.1:${server.getListeningPort()}`;
});

afterAll(async () => {
  if (server) await server.close();
  if (db) await db.close();
});

test(dbUrl ? 'DB-backed snapshot contains simulated market state' : 'DB-backed snapshot (skipped: no DATABASE_URL)', async () => {
  if (!dbUrl || !db || !server || !url) return;

  const requester = await connectAuthed(url, 'requester-db');
  const worker = await connectAuthed(url, 'worker-db');

  requester.ws.send(JSON.stringify({ v: PROTOCOL_VERSION, type: 'post_job', title: 'task: db job', budget: 25 }));
  const jobPosted = await waitFor(requester.ws, (m) => m.type === 'job_posted');
  const jobId = String((jobPosted as any).job.id);

  worker.ws.send(JSON.stringify({ v: PROTOCOL_VERSION, type: 'bid', jobId, price: 10, etaSeconds: 2 }));
  const bidPosted = await waitFor(requester.ws, (m) => m.type === 'bid_posted');
  const workerId = String((bidPosted as any).bid.bidderId);

  requester.ws.send(JSON.stringify({ v: PROTOCOL_VERSION, type: 'award', jobId, workerId }));
  await waitFor(worker.ws, (m) => m.type === 'job_awarded');

  worker.ws.send(JSON.stringify({ v: PROTOCOL_VERSION, type: 'submit', jobId, result: 'done' }));
  await waitFor(requester.ws, (m) => m.type === 'job_submitted' && String((m as any).jobId) === jobId);
  requester.ws.send(JSON.stringify({ v: PROTOCOL_VERSION, type: 'review', jobId, decision: 'accept' }));
  await waitFor(requester.ws, (m) => m.type === 'job_completed' && String((m as any).jobId) === jobId);

  // DB snapshot should now include both agents + at least this job + bid.
  const snap = await db.getObserverSnapshot();
  expect(snap.agents.length).toBeGreaterThanOrEqual(2);
  expect(snap.jobs.some((j) => j.id === jobId)).toBe(true);
  expect(snap.bids.some((b) => b.jobId === jobId)).toBe(true);

  requester.ws.close();
  worker.ws.close();
});

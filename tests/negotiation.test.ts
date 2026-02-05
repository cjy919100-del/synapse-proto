import WebSocket from 'ws';
import { afterAll, beforeAll, test } from 'vitest';

import { generateEd25519KeyPair, signAuth } from '../src/crypto.js';
import { PROTOCOL_VERSION } from '../src/protocol.js';
import { CoreServer } from '../src/server.js';

type AnyMsg = Record<string, unknown> & { type: string; v: number };

function waitFor(
  ws: WebSocket,
  predicate: (msg: AnyMsg) => boolean,
  timeoutMs = 7_500,
  label = 'waitFor',
): Promise<AnyMsg> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      cleanup();
      reject(new Error(`timeout: ${label}`));
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

  const challenge = await waitFor(ws, (m) => m.type === 'challenge', 7_500, 'challenge');
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

  const authed = await waitFor(ws, (m) => m.type === 'authed', 7_500, 'authed');
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

test('negotiation: counter-offer -> accept -> upfront paid -> settle remainder', async () => {
  const requester = await connectAuthed(url, 'boss');
  const worker = await connectAuthed(url, 'worker');

  // boss posts job with known budget
  requester.ws.send(
    JSON.stringify({
      v: PROTOCOL_VERSION,
      type: 'post_job',
      title: 'task: one-liner',
      budget: 100,
    }),
  );
  const jobPosted = await waitFor(requester.ws, (m) => m.type === 'job_posted', 7_500, 'job_posted');
  const jobId = String((jobPosted as any).job.id);

  // worker bids with terms
  worker.ws.send(
    JSON.stringify({
      v: PROTOCOL_VERSION,
      type: 'bid',
      jobId,
      price: 80,
      etaSeconds: 2,
      terms: { upfrontPct: 0.2, deadlineSeconds: 10, maxRevisions: 1 },
      pitch: 'ready',
    }),
  );

  const bidPosted = await waitFor(
    requester.ws,
    (m) => m.type === 'bid_posted' && String((m as any).bid.jobId) === jobId,
    7_500,
    'bid_posted',
  );
  const workerId = String((bidPosted as any).bid.bidderId);

  // boss counter-offers (same terms for determinism)
  requester.ws.send(
    JSON.stringify({
      v: PROTOCOL_VERSION,
      type: 'counter_offer',
      jobId,
      workerId,
      price: 70,
      terms: { upfrontPct: 0.2, deadlineSeconds: 8, maxRevisions: 1 },
      notes: 'deal?',
    }),
  );

  await waitFor(worker.ws, (m) => m.type === 'offer_made' && String((m as any).jobId) === jobId, 7_500, 'offer_made');

  // Start waiting before accepting so we don't miss fast ledger broadcasts at award time.
  const pOfferResponse = waitFor(
    requester.ws,
    (m) => m.type === 'offer_response' && String((m as any).jobId) === jobId,
    7_500,
    'offer_response',
  );
  const pAwarded = waitFor(
    worker.ws,
    (m) =>
      m.type === 'job_awarded' && String((m as any).jobId) === jobId && Number((m as any).budgetLocked) === 70,
    7_500,
    'job_awarded',
  );
  const pRequesterUpfrontLedger = waitFor(
    requester.ws,
    (m) => m.type === 'ledger_update' && Number((m as any).credits) === requester.credits - 14 && Number((m as any).locked) === 56,
    7_500,
    'requester_upfront_ledger',
  );
  const pWorkerUpfrontLedger = waitFor(
    worker.ws,
    (m) => m.type === 'ledger_update' && Number((m as any).credits) === worker.credits + 14,
    7_500,
    'worker_upfront_ledger',
  );

  worker.ws.send(
    JSON.stringify({
      v: PROTOCOL_VERSION,
      type: 'offer_decision',
      jobId,
      requesterId: requester.agentId,
      decision: 'accept',
      notes: 'ok',
    }),
  );

  await Promise.all([pOfferResponse, pAwarded, pRequesterUpfrontLedger, pWorkerUpfrontLedger]);

  // submit -> boss review accept -> settle (remainder 80 paid)
  const pSubmitted = waitFor(
    requester.ws,
    (m) => m.type === 'job_submitted' && String((m as any).jobId) === jobId,
    7_500,
    'job_submitted',
  );
  worker.ws.send(JSON.stringify({ v: PROTOCOL_VERSION, type: 'submit', jobId, result: 'done' }));
  await pSubmitted;

  const pCompleted = waitFor(
    requester.ws,
    (m) => m.type === 'job_completed' && String((m as any).jobId) === jobId,
    7_500,
    'job_completed',
  );
  const pRequesterFinal = waitFor(
    requester.ws,
    (m) => m.type === 'ledger_update' && Number((m as any).credits) === requester.credits - 70 && Number((m as any).locked) === 0,
    7_500,
    'requester_final_ledger',
  );
  const pWorkerFinal = waitFor(
    worker.ws,
    (m) => m.type === 'ledger_update' && Number((m as any).credits) === worker.credits + 70 && Number((m as any).locked) === 0,
    7_500,
    'worker_final_ledger',
  );

  requester.ws.send(JSON.stringify({ v: PROTOCOL_VERSION, type: 'review', jobId, decision: 'accept' }));
  const [completed] = await Promise.all([pCompleted, pRequesterFinal, pWorkerFinal]);
  if (Number((completed as any).paid) !== 70) throw new Error('expected settled price=70');

  requester.ws.close();
  worker.ws.close();
});

test('negotiation rounds: worker can counter and boss can counter back', async () => {
  const requester = await connectAuthed(url, 'boss2');
  const worker = await connectAuthed(url, 'worker2');

  requester.ws.send(
    JSON.stringify({
      v: PROTOCOL_VERSION,
      type: 'post_job',
      title: 'task: negotiate',
      budget: 120,
    }),
  );
  const jobPosted = await waitFor(requester.ws, (m) => m.type === 'job_posted', 7_500, 'job_posted');
  const jobId = String((jobPosted as any).job.id);

  worker.ws.send(
    JSON.stringify({
      v: PROTOCOL_VERSION,
      type: 'bid',
      jobId,
      price: 90,
      etaSeconds: 3,
      terms: { upfrontPct: 0, deadlineSeconds: 20, maxRevisions: 2 },
    }),
  );
  const bidPosted = await waitFor(
    requester.ws,
    (m) => m.type === 'bid_posted' && String((m as any).bid.jobId) === jobId,
    7_500,
    'bid_posted',
  );
  const workerId = String((bidPosted as any).bid.bidderId);

  // Boss starts with strict offer.
  requester.ws.send(
    JSON.stringify({
      v: PROTOCOL_VERSION,
      type: 'counter_offer',
      jobId,
      workerId,
      price: 86,
      terms: { upfrontPct: 0, deadlineSeconds: 20, maxRevisions: 2 },
      notes: 'initial',
    }),
  );
  await waitFor(worker.ws, (m) => m.type === 'offer_made' && String((m as any).jobId) === jobId, 7_500, 'offer_made');

  const pWorkerCounterBroadcast = waitFor(
    requester.ws,
    (m) =>
      m.type === 'counter_made' &&
      String((m as any).jobId) === jobId &&
      String((m as any).fromRole) === 'worker' &&
      String((m as any).workerId) === workerId,
    7_500,
    'counter_made(worker)',
  );

  // Worker counters.
  worker.ws.send(
    JSON.stringify({
      v: PROTOCOL_VERSION,
      type: 'worker_counter',
      jobId,
      requesterId: requester.agentId,
      price: 92,
      terms: { upfrontPct: 0.2, deadlineSeconds: 10, maxRevisions: 1 },
      notes: 'counter please',
    }),
  );
  await pWorkerCounterBroadcast;

  // Boss counters back by accepting worker terms (echo).
  requester.ws.send(
    JSON.stringify({
      v: PROTOCOL_VERSION,
      type: 'counter_offer',
      jobId,
      workerId,
      price: 88,
      terms: { upfrontPct: 0.2, deadlineSeconds: 10, maxRevisions: 1 },
      notes: 'ok',
    }),
  );
  await waitFor(worker.ws, (m) => m.type === 'offer_made' && String((m as any).jobId) === jobId, 7_500, 'offer_made_2');

  // Worker accepts -> award.
  const pAwarded = waitFor(worker.ws, (m) => m.type === 'job_awarded' && String((m as any).jobId) === jobId, 7_500, 'job_awarded');
  worker.ws.send(
    JSON.stringify({
      v: PROTOCOL_VERSION,
      type: 'offer_decision',
      jobId,
      requesterId: requester.agentId,
      decision: 'accept',
      notes: 'deal',
    }),
  );
  await pAwarded;

  requester.ws.close();
  worker.ws.close();
});

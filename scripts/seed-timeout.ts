import 'dotenv/config';

import WebSocket from 'ws';

import { generateEd25519KeyPair, signAuth } from '../src/crypto.js';
import { PROTOCOL_VERSION } from '../src/protocol.js';

type AnyMsg = Record<string, unknown> & { type: string; v: number };

function waitFor(ws: WebSocket, predicate: (msg: AnyMsg) => boolean, timeoutMs = 10_000): Promise<AnyMsg> {
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
  return { ws, agentId: String(authed.agentId) };
}

async function main() {
  const url = process.env.SYNAPSE_URL ?? 'ws://localhost:8787';
  // eslint-disable-next-line no-console
  console.log(`[seed-timeout] connecting ${url}`);

  const requester = await connectAuthed(url, 'timeout-requester');
  const worker = await connectAuthed(url, 'timeout-worker');

  requester.ws.send(
    JSON.stringify({
      v: PROTOCOL_VERSION,
      type: 'post_job',
      title: '[timeout demo] do nothing and timeout',
      description: 'This job is intentionally not submitted to trigger timeout + slash + reopen.',
      budget: 200,
      kind: 'simple',
      payload: { timeoutSeconds: 2 },
    }),
  );

  const jobPosted = await waitFor(requester.ws, (m) => m.type === 'job_posted');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const jobId = String((jobPosted as any).job.id);
  // eslint-disable-next-line no-console
  console.log(`[seed-timeout] jobId=${jobId}`);

  worker.ws.send(JSON.stringify({ v: PROTOCOL_VERSION, type: 'bid', jobId, price: 10, etaSeconds: 2 }));
  const bidPosted = await waitFor(
    requester.ws,
    (m) => m.type === 'bid_posted' && typeof (m as any).bid?.bidderId === 'string' && (m as any).bid.bidderId === worker.agentId,
    10_000,
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const workerId = String((bidPosted as any).bid.bidderId);

  requester.ws.send(JSON.stringify({ v: PROTOCOL_VERSION, type: 'award', jobId, workerId }));
  await waitFor(worker.ws, (m) => m.type === 'job_awarded');

  // Now do nothing; server should timeout -> fail -> reopen.
  await waitFor(requester.ws, (m) => m.type === 'job_failed' && String((m as any).jobId) === jobId, 12_000);
  // eslint-disable-next-line no-console
  console.log('[seed-timeout] observed job_failed (timeout)');

  requester.ws.close();
  worker.ws.close();

  // Print a deeplink URL the dashboard understands.
  // eslint-disable-next-line no-console
  console.log(`[seed-timeout] open http://localhost:8790/?job=${encodeURIComponent(jobId)}`);
}

void main();

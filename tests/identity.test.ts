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

async function connectWithKey(
  url: string,
  agentName: string,
  publicKeyDerB64: string,
  privateKey: unknown,
) {
  const ws = new WebSocket(url);
  const challenge = await waitFor(ws, (m) => m.type === 'challenge');
  const nonce = String(challenge.nonce);
  const signature = signAuth({ nonceB64: nonce, agentName, publicKeyDerB64, privateKey: privateKey as any });

  ws.send(JSON.stringify({ v: PROTOCOL_VERSION, type: 'auth', agentName, publicKey: publicKeyDerB64, signature, nonce }));
  const authed = await waitFor(ws, (m) => m.type === 'authed');
  return { ws, agentId: String(authed.agentId) };
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

test('agentId is stable across reconnects for the same public key', async () => {
  const keyPair = generateEd25519KeyPair();
  const a1 = await connectWithKey(url, 'agent', keyPair.publicKeyDerB64, keyPair.privateKey);
  a1.ws.close();
  const a2 = await connectWithKey(url, 'agent', keyPair.publicKeyDerB64, keyPair.privateKey);
  a2.ws.close();

  expect(a2.agentId).toBe(a1.agentId);
});

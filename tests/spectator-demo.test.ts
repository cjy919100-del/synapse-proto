import http from 'node:http';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { CoreServer } from '../src/server.js';
import { SpectatorServer } from '../src/spectator.js';

function postJson(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request(
      {
        method: 'POST',
        hostname: u.hostname,
        port: Number(u.port),
        path: u.pathname,
        headers: { 'content-type': 'application/json' },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += String(c)));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (err) {
            reject(err);
          }
        });
      },
    );
    req.on('error', reject);
    req.end('{}');
  });
}

describe('spectator demo endpoint', () => {
  let core: CoreServer;
  let spectator: SpectatorServer;

  beforeAll(() => {
    core = new CoreServer(0);
    spectator = new SpectatorServer({ port: 0 as any, core });
  });

  afterAll(async () => {
    await spectator.close();
    await core.close();
  });

  test('POST /api/demo/timeout returns jobId and creates an awarded job', async () => {
    // SpectatorServer doesn't currently expose its port; use the configured one when non-zero.
    // For this test, we use a fixed port to avoid needing internal plumbing.
    await spectator.close();
    spectator = new SpectatorServer({ port: 8799, core });

    const res = await postJson('http://localhost:8799/api/demo/timeout');
    expect(res.ok).toBe(true);
    expect(typeof res.jobId).toBe('string');

    const snap = await core.getObserverSnapshot();
    const job = snap.jobs.find((j) => j.id === res.jobId);
    expect(job).toBeTruthy();
    expect(job!.status).toBe('awarded');
  });
});


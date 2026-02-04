import { readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { WebSocketServer } from 'ws';
import type WebSocket from 'ws';

import { PROTOCOL_VERSION } from './protocol.js';
import type { CoreServer, ObserverSnapshot } from './server.js';

type SpectatorMsg =
  | { v: number; type: 'snapshot'; data: ObserverSnapshot }
  | { v: number; type: 'event'; data: unknown };

export type SpectatorServerOptions = {
  port: number;
  core: CoreServer;
};

export class SpectatorServer {
  private readonly httpServer: http.Server;
  private readonly wss: WebSocketServer;
  private readonly sockets = new Set<WebSocket>();

  constructor(readonly opts: SpectatorServerOptions) {
    this.httpServer = http.createServer((req, res) => void this.handleHttp(req, res));
    this.wss = new WebSocketServer({ server: this.httpServer, path: '/observer' });
    this.wss.on('connection', (ws) => this.onWs(ws));

    opts.core.on('tape', (evt) => this.broadcast({ v: PROTOCOL_VERSION, type: 'event', data: evt }));

    this.httpServer.listen(opts.port);
    // eslint-disable-next-line no-console
    console.log(`[spectator] http://localhost:${opts.port}  ws://localhost:${opts.port}/observer`);
  }

  async close(): Promise<void> {
    for (const ws of this.sockets) ws.close();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    await new Promise<void>((resolve) => this.httpServer.close(() => resolve()));
  }

  private onWs(ws: WebSocket) {
    this.sockets.add(ws);
    ws.on('close', () => this.sockets.delete(ws));
    ws.on('error', () => this.sockets.delete(ws));

    void this.opts.core
      .getObserverSnapshot()
      .then((snap) => {
        const msg: SpectatorMsg = { v: PROTOCOL_VERSION, type: 'snapshot', data: snap };
        ws.send(JSON.stringify(msg));
      })
      .catch(() => {
        const msg: SpectatorMsg = {
          v: PROTOCOL_VERSION,
          type: 'snapshot',
          data: { agents: [], jobs: [], bids: [], evidence: [] },
        };
        ws.send(JSON.stringify(msg));
      });
  }

  private broadcast(msg: SpectatorMsg) {
    const text = JSON.stringify(msg);
    for (const ws of this.sockets) {
      if (ws.readyState === ws.OPEN) ws.send(text);
    }
  }

  private async handleHttp(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = req.url ?? '/';
    const pathname = url.split('?')[0] ?? '/';

    if (req.method === 'POST' && pathname === '/api/demo/timeout') {
      await this.handleDemoTimeout(req, res);
      return;
    }

    const root = this.publicRoot();
    const file = pathname === '/' ? path.join(root, 'index.html') : path.join(root, pathname.replace(/^\//, ''));

    // Basic path traversal guard.
    if (!file.startsWith(root)) {
      res.writeHead(403);
      res.end('forbidden');
      return;
    }

    try {
      const data = await readFile(file);
      res.writeHead(200, { 'content-type': contentType(file) });
      res.end(data);
    } catch {
      res.writeHead(404);
      res.end('not_found');
    }
  }

  private async handleDemoTimeout(_req: http.IncomingMessage, res: http.ServerResponse) {
    try {
      // Seed a single, easy-to-understand story:
      // "worker got awarded, then missed the deadline -> timeout -> slashed -> job reopened"
      const requesterId = 'demo:requester';
      const workerId = 'demo:worker';
      await this.opts.core.systemEnsureAccount({ agentId: requesterId, agentName: 'demo-requester', startingCredits: 10_000 });
      await this.opts.core.systemEnsureAccount({ agentId: workerId, agentName: 'demo-worker', startingCredits: 1_000 });

      const jobId = await this.opts.core.systemCreateJob({
        requesterId,
        title: 'Demo: deadline missed -> slashed -> reopened',
        description: 'This demo job intentionally times out to show stake/slash, evidence, and auto-reopen.',
        budget: 400,
        kind: 'simple',
        payload: { timeoutSeconds: 3 },
      });
      await this.opts.core.systemAwardJob({ jobId, workerId });

      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, jobId }));
    } catch (err) {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
    }
  }

  private publicRoot(): string {
    // Resolve to workspace-root/public when running from tsx.
    const here = path.dirname(fileURLToPath(import.meta.url));
    return path.resolve(here, '..', 'public');
  }
}

function contentType(file: string): string {
  if (file.endsWith('.html')) return 'text/html; charset=utf-8';
  if (file.endsWith('.css')) return 'text/css; charset=utf-8';
  if (file.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (file.endsWith('.svg')) return 'image/svg+xml';
  return 'application/octet-stream';
}

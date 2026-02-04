import crypto from 'node:crypto';
import http from 'node:http';

import type { CoreServer } from '../server.js';

import { GithubBridge } from './bridge.js';

function timingSafeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export function verifyGithubSignature(args: {
  secret: string;
  rawBody: Buffer;
  signatureHeader: string | undefined;
}): boolean {
  const header = args.signatureHeader;
  if (!header) return false;
  // GitHub: "sha256=<hex>"
  const m = /^sha256=([a-f0-9]{64})$/i.exec(header.trim());
  if (!m) return false;
  const expected = crypto.createHmac('sha256', args.secret).update(args.rawBody).digest('hex');
  return timingSafeEqualHex(expected, m[1]!.toLowerCase());
}

async function readRawBody(req: http.IncomingMessage, limitBytes = 1_000_000): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBuffer);
    total += buf.length;
    if (total > limitBytes) throw new Error('body_too_large');
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

export class GithubWebhookServer {
  private readonly server: http.Server;

  constructor(
    private readonly core: CoreServer,
    private readonly opts: { port: number; secret?: string; payOn?: 'checks_success' | 'merge' },
  ) {
    this.server = http.createServer((req, res) => void this.onRequest(req, res));
  }

  listen(): void {
    this.server.listen(this.opts.port);
    // eslint-disable-next-line no-console
    console.log(`[github] webhook: http://localhost:${this.opts.port}/github/webhook`);
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  private async onRequest(req: http.IncomingMessage, res: http.ServerResponse) {
    try {
      if (req.method !== 'POST' || (req.url ?? '') !== '/github/webhook') {
        res.statusCode = 404;
        res.end('not_found');
        return;
      }

      const rawBody = await readRawBody(req);
      if (this.opts.secret) {
        const ok = verifyGithubSignature({
          secret: this.opts.secret,
          rawBody,
          signatureHeader: req.headers['x-hub-signature-256'] as string | undefined,
        });
        if (!ok) {
          res.statusCode = 401;
          res.end('bad_signature');
          return;
        }
      }

      const event = String(req.headers['x-github-event'] ?? '');
      const deliveryId = String(req.headers['x-github-delivery'] ?? '');
      const payload = JSON.parse(rawBody.toString('utf8')) as unknown;

      const bridge = new GithubBridge(this.core, { payOn: this.opts.payOn });
      await bridge.handle({ event, deliveryId, payload });

      res.statusCode = 200;
      res.end('ok');
    } catch (err) {
      res.statusCode = 500;
      res.end((err as Error).message);
    }
  }
}


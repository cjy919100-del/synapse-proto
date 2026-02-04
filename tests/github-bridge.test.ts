import { describe, expect, test } from 'vitest';
import crypto from 'node:crypto';

import { GithubBridge } from '../src/github/bridge.js';
import { verifyGithubSignature } from '../src/github/webhook_server.js';
import { CoreServer } from '../src/server.js';

describe('GitHub PR-bounty bridge', () => {
  test('issue -> job -> PR -> checks -> settlement', async () => {
    const core = new CoreServer(0);
    try {
      const bridge = new GithubBridge(core, { repoStartingCredits: 1_000, payOn: 'checks_success' });

      const issuePayload = {
        action: 'opened',
        repository: { name: 'demo', owner: { login: 'cjy5507' } },
        issue: {
          number: 12,
          title: '[synapse] Add util fn',
          body: 'budget: 333\n\nImplement X.\n',
          labels: [{ name: 'synapse' }],
        },
      };

      await bridge.handle({ event: 'issues', payload: issuePayload });

      const jobId = await core.systemGetJobIdByGithubIssue({ owner: 'cjy5507', repo: 'demo', issueNumber: 12 });
      expect(jobId).toBeTruthy();

      let snap = await core.getObserverSnapshot();
      const job = snap.jobs.find((j) => j.id === jobId)!;
      expect(job.kind).toBe('github_pr_bounty');
      expect(job.budget).toBe(333);
      expect(job.status).toBe('open');

      const prPayload = {
        action: 'opened',
        repository: { name: 'demo', owner: { login: 'cjy5507' } },
        pull_request: {
          number: 5,
          body: 'Synapse-Job: 12\n\nHere is the fix.',
          user: { login: 'alice' },
          merged: false,
          head: { sha: 'abc123' },
        },
      };

      await bridge.handle({ event: 'pull_request', payload: prPayload });

      snap = await core.getObserverSnapshot();
      const afterAward = snap.jobs.find((j) => j.id === jobId)!;
      expect(afterAward.status).toBe('awarded');
      expect(afterAward.workerId).toBe('gh:alice');

      const requester = snap.agents.find((a) => a.agentId === 'ghrepo:cjy5507/demo')!;
      const worker = snap.agents.find((a) => a.agentId === 'gh:alice')!;
      expect(requester.locked).toBe(333);
      expect(worker.credits).toBeGreaterThan(0); // bot faucet for stake
      expect(worker.locked).toBeGreaterThan(0); // stake locked

      const checksPayload = {
        action: 'completed',
        repository: { name: 'demo', owner: { login: 'cjy5507' } },
        check_suite: {
          conclusion: 'success',
          pull_requests: [{ number: 5 }],
        },
      };

      await bridge.handle({ event: 'check_suite', payload: checksPayload });

      snap = await core.getObserverSnapshot();
      const afterDone = snap.jobs.find((j) => j.id === jobId)!;
      expect(afterDone.status).toBe('completed');

      const requester2 = snap.agents.find((a) => a.agentId === 'ghrepo:cjy5507/demo')!;
      const worker2 = snap.agents.find((a) => a.agentId === 'gh:alice')!;
      expect(requester2.locked).toBe(0);
      expect(requester2.credits).toBe(1_000 - 333);
      expect(worker2.credits).toBeGreaterThanOrEqual(333);
      expect(worker2.locked).toBe(0); // stake unlocked
    } finally {
      await core.close();
    }
  });
});

describe('GitHub webhook signature', () => {
  test('verifyGithubSignature validates sha256 HMAC', () => {
    const secret = 's3cr3t';
    const rawBody = Buffer.from(JSON.stringify({ hello: 'world' }), 'utf8');
    const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');

    const ok = verifyGithubSignature({ secret, rawBody, signatureHeader: `sha256=${expected}` });
    expect(ok).toBe(true);

    const bad = verifyGithubSignature({ secret, rawBody, signatureHeader: `sha256=${expected.replace(/a/g, 'b')}` });
    expect(bad).toBe(false);
  });
});

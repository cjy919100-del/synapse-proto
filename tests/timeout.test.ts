import { describe, expect, test, vi } from 'vitest';

import { CoreServer } from '../src/server.js';

describe('job timeout', () => {
  test('awarded job auto-fails and reopens after timeoutSeconds', async () => {
    vi.useFakeTimers();
    const core = new CoreServer(0);
    try {
      await core.systemEnsureAccount({ agentId: 'req', agentName: 'req', startingCredits: 10_000 });
      await core.systemEnsureAccount({ agentId: 'worker', agentName: 'worker', startingCredits: 1_000 });

      const jobId = await core.systemCreateJob({
        requesterId: 'req',
        title: 'timeout job',
        budget: 100,
        kind: 'simple',
        payload: { timeoutSeconds: 1 },
      });
      await core.systemAwardJob({ jobId, workerId: 'worker' });

      // Timeout triggers fail + reopen.
      await vi.advanceTimersByTimeAsync(1_200);

      const snap = await core.getObserverSnapshot();
      const job = snap.jobs.find((j) => j.id === jobId)!;
      expect(job.status).toBe('open');

      const w = snap.agents.find((a) => a.agentId === 'worker')!;
      expect(w.rep.failed).toBeGreaterThanOrEqual(1);
      expect(snap.evidence.some((e) => e.jobId === jobId && e.kind === 'settlement')).toBe(true);
    } finally {
      await core.close();
      vi.useRealTimers();
    }
  });
});


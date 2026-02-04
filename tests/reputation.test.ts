import { describe, expect, test } from 'vitest';

import { CoreServer } from '../src/server.js';

describe('reputation', () => {
  test('updates on complete and fail (laplace-smoothed score)', async () => {
    const core = new CoreServer(0);
    try {
      await core.systemEnsureAccount({ agentId: 'req', agentName: 'req', startingCredits: 10_000 });
      await core.systemEnsureAccount({ agentId: 'worker', agentName: 'worker', startingCredits: 0 });

      const job1 = await core.systemCreateJob({
        requesterId: 'req',
        title: 'job1',
        budget: 100,
        kind: 'simple',
      });
      await core.systemAwardJob({ jobId: job1, workerId: 'worker' });
      await core.systemCompleteJob({ jobId: job1, workerId: 'worker' });

      let snap = await core.getObserverSnapshot();
      let w = snap.agents.find((a) => a.agentId === 'worker')!;
      expect(w.rep.completed).toBe(1);
      expect(w.rep.failed).toBe(0);
      expect(w.rep.score).toBeCloseTo(2 / 3, 6);

      const job2 = await core.systemCreateJob({
        requesterId: 'req',
        title: 'job2',
        budget: 100,
        kind: 'simple',
      });
      await core.systemAwardJob({ jobId: job2, workerId: 'worker' });
      await core.systemFailJob({ jobId: job2, workerId: 'worker', reason: 'ci_failed' });

      snap = await core.getObserverSnapshot();
      w = snap.agents.find((a) => a.agentId === 'worker')!;
      expect(w.rep.completed).toBe(1);
      expect(w.rep.failed).toBe(1);
      expect(w.rep.score).toBeCloseTo(0.5, 6);
    } finally {
      await core.close();
    }
  });
});


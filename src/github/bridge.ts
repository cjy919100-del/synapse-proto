import type { CoreServer } from '../server.js';

import { hasSynapseLabel, isObject, parseBudgetFromText, parseSynapseJobRefFromText } from './parse.js';

type GithubWebhook = {
  event: string;
  deliveryId?: string;
  payload: unknown;
};

const DEFAULT_BOUNTY_BUDGET = 200;
const DEFAULT_REPO_STARTING_CREDITS = 50_000;
const DEFAULT_GH_USER_STARTING_CREDITS = 1_000;

function repoKey(owner: string, repo: string): string {
  return `${owner}/${repo}`;
}

function repoAgentId(owner: string, repo: string): string {
  return `ghrepo:${repoKey(owner, repo)}`;
}

function userAgentId(login: string): string {
  return `gh:${login}`;
}

export class GithubBridge {
  constructor(
    private readonly core: CoreServer,
    private readonly opts?: {
      repoStartingCredits?: number;
      defaultBudget?: number;
      payOn?: 'checks_success' | 'merge';
    },
  ) {}

  async handle(evt: GithubWebhook): Promise<void> {
    if (!evt.event) return;
    if (evt.event === 'issues') return await this.onIssues(evt.payload);
    if (evt.event === 'pull_request') return await this.onPullRequest(evt.payload);
    if (evt.event === 'check_suite') return await this.onCheckSuite(evt.payload);
  }

  private async onIssues(payload: unknown): Promise<void> {
    if (!isObject(payload)) return;
    const action = typeof payload.action === 'string' ? payload.action : null;
    if (!action) return;

    // We only create jobs on open/reopen or when labeled.
    const shouldConsider = action === 'opened' || action === 'reopened' || action === 'labeled' || action === 'edited';
    if (!shouldConsider) return;

    const repo = payload.repository;
    const issue = payload.issue;
    if (!isObject(repo) || !isObject(issue)) return;

    const repoName = isObject(repo.owner) && typeof repo.owner.login === 'string' ? repo.owner.login : null;
    const repoSlug = typeof repo.name === 'string' ? repo.name : null;
    if (!repoName || !repoSlug) return;

    const issueNumber = typeof issue.number === 'number' ? Math.floor(issue.number) : null;
    const title = typeof issue.title === 'string' ? issue.title : null;
    const body = typeof issue.body === 'string' ? issue.body : '';
    const labels = issue.labels;
    if (!issueNumber || !title) return;

    // Trigger rule: label "synapse" OR title starts with "[synapse]".
    const titleTrigger = title.trim().toLowerCase().startsWith('[synapse]');
    if (!titleTrigger && !hasSynapseLabel(labels)) return;

    const owner = repoName;
    const repoN = repoSlug;

    const requesterId = repoAgentId(owner, repoN);
    const requesterName = requesterId;
    const startingCredits = this.opts?.repoStartingCredits ?? DEFAULT_REPO_STARTING_CREDITS;
    await this.core.systemEnsureAccount({ agentId: requesterId, agentName: requesterName, startingCredits });

    const budget = parseBudgetFromText(body) ?? this.opts?.defaultBudget ?? DEFAULT_BOUNTY_BUDGET;

    const existingJobId = await this.core.systemGetJobIdByGithubIssue({ owner, repo: repoN, issueNumber });
    if (existingJobId) return;

    const jobId = await this.core.systemCreateJob({
      requesterId,
      title: title.replace(/^\[synapse\]\s*/i, '').trim() || title,
      description: body,
      budget,
      kind: 'github_pr_bounty',
      payload: {
        github: { owner, repo: repoN, issueNumber },
      },
    });

    await this.core.systemLinkGithubIssue({ owner, repo: repoN, issueNumber, jobId });
    await this.core.systemAddEvidence({
      jobId,
      kind: 'github_issue',
      detail: `${owner}/${repoN}#${issueNumber} budget=${budget}`,
      payload: { owner, repo: repoN, issueNumber, budget },
    });
  }

  private async onPullRequest(payload: unknown): Promise<void> {
    if (!isObject(payload)) return;
    const action = typeof payload.action === 'string' ? payload.action : null;
    if (!action) return;

    const repo = payload.repository;
    const pr = payload.pull_request;
    if (!isObject(repo) || !isObject(pr)) return;

    const owner = isObject(repo.owner) && typeof repo.owner.login === 'string' ? repo.owner.login : null;
    const repoN = typeof repo.name === 'string' ? repo.name : null;
    if (!owner || !repoN) return;

    const prNumber = typeof pr.number === 'number' ? Math.floor(pr.number) : null;
    const prBody = typeof pr.body === 'string' ? pr.body : '';
    const prUser = isObject(pr.user) && typeof pr.user.login === 'string' ? pr.user.login : null;
    const merged = typeof pr.merged === 'boolean' ? pr.merged : false;
    const headSha = isObject(pr.head) && typeof pr.head.sha === 'string' ? pr.head.sha : null;
    const prUrl = typeof pr.html_url === 'string' ? pr.html_url : null;
    if (!prNumber) return;

    const refIssueNumber = parseSynapseJobRefFromText(prBody);
    if (!refIssueNumber) {
      // If a linked PR was closed without merge, we still want to reopen the job.
      if (action === 'closed') {
        const jobId = await this.core.systemGetJobIdByGithubPr({ owner, repo: repoN, prNumber });
        if (jobId && !merged) await this.core.systemReopenJob({ jobId });
      }
      return;
    }

    const jobId = await this.core.systemGetJobIdByGithubIssue({ owner, repo: repoN, issueNumber: refIssueNumber });
    if (!jobId) return;

    await this.core.systemLinkGithubPr({
      owner,
      repo: repoN,
      prNumber,
      jobId,
      headSha: headSha ?? undefined,
      authorLogin: prUser ?? undefined,
      merged,
    });
    await this.core.systemAddEvidence({
      jobId,
      kind: 'github_pr',
      detail: `${owner}/${repoN}#${prNumber} author=${prUser ?? '?'} sha=${headSha?.slice(0, 8) ?? '?'}`,
      payload: { owner, repo: repoN, prNumber, prUrl, author: prUser, headSha },
    });

    if (action === 'opened' || action === 'reopened' || action === 'edited' || action === 'synchronize') {
      if (!prUser) return;
      const workerId = userAgentId(prUser);
      await this.core.systemEnsureAccount({
        agentId: workerId,
        agentName: workerId,
        startingCredits: DEFAULT_GH_USER_STARTING_CREDITS,
      });

      // Award only once.
      const snapshot = await this.core.getObserverSnapshot();
      const job = snapshot.jobs.find((j) => j.id === jobId);
      if (job && job.status === 'open') {
        try {
          await this.core.systemAwardJob({ jobId, workerId });
        } catch (err) {
          await this.core.systemAddEvidence({
            jobId,
            kind: 'award_failed',
            detail: `worker=${workerId} error=${(err as Error).message}`,
          });
        }
      }
    }

    if (action === 'closed' && !merged) {
      await this.core.systemReopenJob({ jobId });
    }

    // If we pay on merge, the close+merged event is enough.
    const payOn = this.opts?.payOn ?? 'checks_success';
    if (action === 'closed' && merged && payOn === 'merge' && prUser) {
      const workerId = userAgentId(prUser);
      await this.core.systemEnsureAccount({
        agentId: workerId,
        agentName: workerId,
        startingCredits: DEFAULT_GH_USER_STARTING_CREDITS,
      });
      await this.core.systemCompleteJob({ jobId, workerId });
    }
  }

  private async onCheckSuite(payload: unknown): Promise<void> {
    if (!isObject(payload)) return;
    const action = typeof payload.action === 'string' ? payload.action : null;
    if (action !== 'completed') return;

    const repo = payload.repository;
    const suite = payload.check_suite;
    if (!isObject(repo) || !isObject(suite)) return;

    const owner = isObject(repo.owner) && typeof repo.owner.login === 'string' ? repo.owner.login : null;
    const repoN = typeof repo.name === 'string' ? repo.name : null;
    if (!owner || !repoN) return;

    const conclusion = typeof suite.conclusion === 'string' ? suite.conclusion : null;
    if (!conclusion) return;

    const prs = Array.isArray(suite.pull_requests) ? suite.pull_requests : [];
    const prNumber = prs.length > 0 && isObject(prs[0]) && typeof prs[0].number === 'number' ? prs[0].number : null;
    if (!prNumber) return;

    const payOn = this.opts?.payOn ?? 'checks_success';
    if (payOn !== 'checks_success') return;

    const jobId = await this.core.systemGetJobIdByGithubPr({ owner, repo: repoN, prNumber: Math.floor(prNumber) });
    if (!jobId) return;

    // Determine the worker from the awarded job (or fallback to PR author if present in payload).
    const snapshot = await this.core.getObserverSnapshot();
    const job = snapshot.jobs.find((j) => j.id === jobId);
    if (!job || job.status !== 'awarded' || !job.workerId) return;

    await this.core.systemAddEvidence({
      jobId,
      kind: 'github_checks',
      detail: `${owner}/${repoN}#${prNumber} conclusion=${conclusion}`,
      payload: { owner, repo: repoN, prNumber, conclusion },
    });

    if (conclusion === 'success') {
      await this.core.systemCompleteJob({ jobId, workerId: job.workerId });
      return;
    }

    // Fail attempt, then reopen to keep the market moving.
    await this.core.systemFailJob({ jobId, workerId: job.workerId, reason: `checks_${conclusion}` });
    await this.core.systemReopenJob({ jobId });
  }
}

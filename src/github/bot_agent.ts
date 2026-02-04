import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import WebSocket, { type RawData } from 'ws';

import { generateEd25519KeyPair, signAuth } from '../crypto.js';
import {
  PROTOCOL_VERSION,
  type AgentToServerMsg,
  type AuthMsg,
  type ChallengeMsg,
  type Job,
  type JobAwardedMsg,
  type JobPostedMsg,
  ServerToAgentMsgSchema,
} from '../protocol.js';
import { AgentLlm } from '../llm.js';

import { extractFencedDiff, isObject } from './parse.js';

type BotConfig = {
  url: string;
  name: string;
  /** If set, only act on jobs for this repo (owner/repo). */
  onlyRepo?: string;
  /** Close the process after opening one PR successfully. */
  exitAfterOne?: boolean;
  /** Append to PR body. */
  prBodySuffix?: string;
};

type GithubRef = { owner: string; repo: string; issueNumber: number };

function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; input?: string } = {},
): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += String(d)));
    child.stderr.on('data', (d) => (err += String(d)));
    child.on('close', (code) => resolve({ code: code ?? 1, out, err }));
    if (opts.input) {
      child.stdin.write(opts.input);
    }
    child.stdin.end();
  });
}

function parseGithubRef(job: Job): GithubRef | null {
  if (!isObject(job.payload)) return null;
  const gh = job.payload.github;
  if (!isObject(gh)) return null;
  const owner = typeof gh.owner === 'string' ? gh.owner : null;
  const repo = typeof gh.repo === 'string' ? gh.repo : null;
  const issueNumber = typeof gh.issueNumber === 'number' ? Math.floor(gh.issueNumber) : null;
  if (!owner || !repo || !issueNumber) return null;
  return { owner, repo, issueNumber };
}

function repoSlug(ref: GithubRef): string {
  return `${ref.owner}/${ref.repo}`;
}

export class GithubBotAgent {
  private readonly ws: WebSocket;
  private readonly keyPair = generateEd25519KeyPair();
  private agentId: string | null = null;
  private readonly jobs = new Map<string, Job>();
  private readonly llm = new AgentLlm();
  private openedCount = 0;

  constructor(readonly cfg: BotConfig) {
    this.ws = new WebSocket(cfg.url);
    this.ws.on('open', () => this.log(`[gh-bot] connected: ${cfg.url}`));
    this.ws.on('message', (raw: RawData) => void this.onMessage(raw.toString('utf8')));
    this.ws.on('close', () => this.log('[gh-bot] disconnected'));
  }

  close() {
    this.ws.close();
  }

  private onMessage(text: string) {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return;
    }
    const parsed = ServerToAgentMsgSchema.safeParse(json);
    if (!parsed.success) return;
    const msg = parsed.data;

    switch (msg.type) {
      case 'challenge':
        return this.onChallenge(msg);
      case 'authed':
        this.agentId = msg.agentId;
        this.log(`[gh-bot] authed id=${msg.agentId.slice(0, 8)} credits=${msg.credits}`);
        return;
      case 'job_posted':
        return this.onJobPosted(msg);
      case 'job_awarded':
        return this.onJobAwarded(msg);
      case 'error':
        this.log(`[gh-bot] server_error=${msg.message}`);
        return;
      default:
        return;
    }
  }

  private onChallenge(msg: ChallengeMsg) {
    const signature = signAuth({
      nonceB64: msg.nonce,
      agentName: this.cfg.name,
      publicKeyDerB64: this.keyPair.publicKeyDerB64,
      privateKey: this.keyPair.privateKey,
    });
    const auth: AuthMsg = {
      v: PROTOCOL_VERSION,
      type: 'auth',
      agentName: this.cfg.name,
      publicKey: this.keyPair.publicKeyDerB64,
      signature,
      nonce: msg.nonce,
    };
    this.send(auth);
  }

  private onJobPosted(msg: JobPostedMsg) {
    if (!this.agentId) return;
    if (msg.job.status !== 'open') return;
    if (msg.job.kind !== 'github_pr_bounty') return;

    const ref = parseGithubRef(msg.job);
    if (!ref) return;
    if (this.cfg.onlyRepo && repoSlug(ref) !== this.cfg.onlyRepo) return;

    this.jobs.set(msg.job.id, msg.job);

    const bid: AgentToServerMsg = {
      v: PROTOCOL_VERSION,
      type: 'bid',
      jobId: msg.job.id,
      price: Math.min(msg.job.budget, 10),
      etaSeconds: 120,
    };
    this.send(bid);
  }

  private onJobAwarded(msg: JobAwardedMsg) {
    if (!this.agentId) return;
    if (msg.workerId !== this.agentId) return;

    const job = this.jobs.get(msg.jobId);
    if (!job) return;
    void this.handleAwardedJob(job).catch((err) => this.log(`[gh-bot] job_failed: ${err.message}`));
  }

  private async handleAwardedJob(job: Job) {
    const ref = parseGithubRef(job);
    if (!ref) throw new Error('missing_github_ref');
    if (this.cfg.onlyRepo && repoSlug(ref) !== this.cfg.onlyRepo) return;

    // Fast-fail if gh isn't ready.
    const auth = await run('gh', ['auth', 'status']);
    if (auth.code !== 0) throw new Error(`gh_not_authed:${auth.err || auth.out}`);

    const dir = await mkdtemp(path.join(os.tmpdir(), 'synapse-ghbot-'));
    try {
      const slug = repoSlug(ref);
      const clone = await run('gh', ['repo', 'clone', slug, dir, '--', '--depth', '1']);
      if (clone.code !== 0) throw new Error(`clone_failed:${clone.err || clone.out}`);

      const branch = `synapse/issue-${ref.issueNumber}-${job.id.slice(0, 8)}`;
      const co = await run('git', ['checkout', '-b', branch], { cwd: dir });
      if (co.code !== 0) throw new Error(`git_checkout_failed:${co.err || co.out}`);

      const issueText = `${job.title}\n\n${job.description ?? ''}`.trim();

      const fencedDiff = extractFencedDiff(job.description ?? '');
      if (fencedDiff) {
        const patchPath = path.join(dir, '.synapse.patch');
        await writeFile(patchPath, fencedDiff, 'utf8');
        const apply = await run('git', ['apply', '--whitespace=nowarn', patchPath], { cwd: dir });
        if (apply.code !== 0) throw new Error(`git_apply_failed:${apply.err || apply.out}`);
      } else {
        // Minimal LLM mode: ask for a patch (unified diff). Keep it explicit to avoid "explanations only".
        const contextHint = existsSync(path.join(dir, 'package.json'))
          ? await readFile(path.join(dir, 'package.json'), 'utf8').then((s) => s.slice(0, 4000))
          : '';
        const patch = await this.llm.solveRepoPatchTask({
          repo: slug,
          issue: issueText,
          contextHint,
        });
        const patchPath = path.join(dir, '.synapse.patch');
        await writeFile(patchPath, patch, 'utf8');
        const apply = await run('git', ['apply', '--whitespace=nowarn', patchPath], { cwd: dir });
        if (apply.code !== 0) throw new Error(`git_apply_failed_llm:${apply.err || apply.out}`);
      }

      // Best-effort local verification (optional).
      if (existsSync(path.join(dir, 'package.json'))) {
        const test = await run('npm', ['test'], { cwd: dir });
        if (test.code !== 0) throw new Error(`local_tests_failed:${test.err || test.out}`);
      }

      const commit = await run('git', ['status', '--porcelain'], { cwd: dir });
      if (commit.code !== 0) throw new Error(`git_status_failed:${commit.err || commit.out}`);
      if (!commit.out.trim()) throw new Error('no_changes_to_commit');

      const add = await run('git', ['add', '-A'], { cwd: dir });
      if (add.code !== 0) throw new Error(`git_add_failed:${add.err || add.out}`);
      const cmt = await run('git', ['commit', '-m', `synapse: issue #${ref.issueNumber}`], { cwd: dir });
      if (cmt.code !== 0) throw new Error(`git_commit_failed:${cmt.err || cmt.out}`);
      const push = await run('git', ['push', '-u', 'origin', branch], { cwd: dir });
      if (push.code !== 0) throw new Error(`git_push_failed:${push.err || push.out}`);

      const bodyLines = [
        `Synapse-Job: ${ref.issueNumber}`,
        '',
        `Fixes #${ref.issueNumber}`,
        '',
        this.cfg.prBodySuffix ?? '',
      ].filter(Boolean);
      const pr = await run(
        'gh',
        ['pr', 'create', '--repo', slug, '--head', branch, '--title', job.title, '--body', bodyLines.join('\n')],
        { cwd: dir },
      );
      if (pr.code !== 0) throw new Error(`gh_pr_create_failed:${pr.err || pr.out}`);

      this.openedCount += 1;
      this.log(`[gh-bot] PR opened: ${pr.out.trim()}`);

      if (this.cfg.exitAfterOne && this.openedCount >= 1) process.exit(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  private send(msg: AgentToServerMsg) {
    if (this.ws.readyState !== this.ws.OPEN) return;
    this.ws.send(JSON.stringify(msg));
  }

  private log(line: string) {
    // eslint-disable-next-line no-console
    console.log(line);
  }
}


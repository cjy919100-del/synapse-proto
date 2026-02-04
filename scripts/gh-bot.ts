import 'dotenv/config';

import { GithubBotAgent } from '../src/github/bot_agent.js';

const url = process.env.SYNAPSE_URL ?? 'ws://localhost:8787';
const name = process.env.SYNAPSE_BOT_NAME ?? 'gh-bot';
const onlyRepo = process.env.SYNAPSE_BOT_ONLY_REPO;
const exitAfterOne = process.env.SYNAPSE_BOT_EXIT_AFTER_ONE === 'true';
const prBodySuffix = process.env.SYNAPSE_BOT_PR_BODY_SUFFIX;

// eslint-disable-next-line no-console
console.log(`[gh-bot] starting: url=${url} name=${name}${onlyRepo ? ` onlyRepo=${onlyRepo}` : ''}`);

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const bot = new GithubBotAgent({ url, name, onlyRepo, exitAfterOne, prBodySuffix });


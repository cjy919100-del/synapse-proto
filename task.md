# Synapse Tasks

## Phase 1 (Done): Terminal Simulation

- [x] Core Server (WS) + fake agents connected and authenticated
- [x] Minimal market loop: post_job -> bid -> award -> submit -> settle
- [x] Ledger updates and basic tape logs

## Phase 2 (Done): Spectator Mode (Web Dashboard)

- [x] Observer WebSocket endpoint (`/observer`) with snapshot + event stream
- [x] Dashboard UI (shadcn-style) showing:
  - [x] Market Tape (live event feed)
  - [x] Jobs table (open/awarded/completed)
  - [x] Agent leaderboard (credits + locked)
- [x] Dev workflow scripts (`dev`, `dash:dev`, `dash:build`)

## Phase 2.5 (Done): Persistence (Postgres)

- [x] Docker Postgres (`docker-compose.yml`)
- [x] Server write-through persistence (agents/ledger/jobs/bids/events)
- [x] `getObserverSnapshot()` reads from DB when `DATABASE_URL` is set
- [x] Unit tests for market loop + optional DB integration test

## Phase 3 (Done): Real Intelligence

- [x] Install `openai` package
- [x] Update Protocol (`src/protocol.ts`) with `kind` and `payload`
- [x] Implement Evaluator (`src/evaluator.ts`) for deterministic checks
- [x] Update Server to run evaluator on `submit`
- [x] Update Agent to use OpenAI for `coding` tasks
- [x] Verify with "Coding Task" scenario (`scripts/verify-coding.ts`)

## Phase 4 (Next): Subjective Evaluation

- [ ] Voting / consensus evaluator for subjective tasks (design, writing)
- [ ] LLM-as-a-judge evaluator (with robust anti-cheat and evidence requirements)

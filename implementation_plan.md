# Phase 2: Spectator Mode (Dashboard) — Implementation Plan

Goal: replace terminal-only visibility with a web dashboard that makes the “agent economy” legible and fun to watch.

## Scope (MVP)

- Live connection indicator
- Market Tape (recent events)
- Jobs view (status + budget + bids count)
- Agents leaderboard (credits + locked)

## Data sources

- Spectator WS: `ws://localhost:8790/observer`
  - `snapshot`: initial state (agents/jobs/bids)
  - `event`: incremental updates (agent auth, ledger updates, and core broadcasts)

## Frontend stack

- Vite + React
- Tailwind + shadcn-style primitives (Card/Table/Badge/Separator)

## Backend changes (already implemented)

- Core server emits `tape` events.
- Spectator server forwards events + serves static dashboard assets.

## Acceptance criteria

- Running backend (`npm run dev`) and UI (`npm run dash:dev`) shows live updates within ~1s.
- Tape keeps last ~120 events and doesn’t grow unbounded.
- Jobs and leaderboard update from streamed events without full refresh.

## Next increments

- Mini “price discovery” widget: bid price histogram per job
- Risk flags: stalled job, repeated failures, agent disconnects
- Replay mode: store tape events to file and replay deterministically

## Persistence notes (Phase 2.5)

- Set `DATABASE_URL` to enable Postgres persistence.
- `getObserverSnapshot()` becomes DB-backed in DB mode.
- Dev traffic from `src/dev.ts` is written through to DB (so restarts keep history/state).

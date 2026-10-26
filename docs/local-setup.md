# Local setup (Cursor bridge fork)

This is the LearnHarness web app with a Cursor ingest path. Cursor is only a source; LearnHarness is the learning app.

## Data directories

Do not hardcode a username. Defaults on this machine:

| Role | Env | Default (Windows) | Default (macOS/Linux) |
| --- | --- | --- | --- |
| LearnHarness data (chats, graph, held-state) | `LH_DATA_DIR` | `%USERPROFILE%\LearnHarness\data` | `~/LearnHarness/data` |
| Cursor capture inbox | `LH_INBOX_DIR` | `%USERPROFILE%\LearnHarness\inbox` | `~/LearnHarness/inbox` |

If `LH_DATA_DIR` is unset, `config.ts` still falls back to the repo `data/` folder (same as upstream web dev). For the Cursor bridge on Windows, set it explicitly so the desktop-style layout is used:

```powershell
$env:LH_DATA_DIR = "$env:USERPROFILE\LearnHarness\data"
New-Item -ItemType Directory -Force -Path $env:LH_DATA_DIR, "$env:USERPROFILE\LearnHarness\inbox" | Out-Null
npm run dev
```

The inbox lives **next to** the data dir (`~/LearnHarness/inbox`), not under `LH_DATA_DIR`, so the capture hook can write while LearnHarness is closed. Inbox files are `<conversation_id>.jsonl` (one JSON object per turn). Files whose names start with `_` are ignored.

## Capture hook (Phase 2)

The hook is not reimplemented here. Install files live in the Project store at `docs/cursor-hook/` (and a copy under `docs/cursor-hook/` in this repo as reference only). Install into `%USERPROFILE%\.cursor\hooks\` as that README describes. The hook writes the inbox; this app watches it when `npm run dev` is running (`NODE_ENV=test` skips the watcher).

## Run

```powershell
npm install
npx tsc --noEmit
npm test          # sets NODE_ENV=test on Windows and Unix (scripts/run-tests.mjs)
$env:LH_DATA_DIR = "$env:USERPROFILE\LearnHarness\data"
npm run dev       # http://localhost:3000
```

Add provider keys in the app (or `auth.json` / `.env.local`). Start a session, or click **Review recent work** on the home composer to pre-fill a goal from ingested Cursor conversations.

## Held-state

Learner outcomes live in `%LH_DATA_DIR%\held\held.jsonl` (append-only). They are never written onto graph nodes. The graph canvas has an optional **Held-state overlay**.

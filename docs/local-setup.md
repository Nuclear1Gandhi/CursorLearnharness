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

## Decision ledger

Choices from Cursor sessions live in `%LH_DATA_DIR%\decisions\decisions.jsonl` (append-only, one writer). The graph stays propositions and chains. Each line has the project, the question, the chosen option, alternatives (strengths + switch condition), reasons, and graph node ids.

Home has a **Decisions** button next to **Review recent work**. Practice from Cursor sources uses why / what-if / compare / architecture / theory — not "what does this code do".

## Re-extract a UI-heavy conversation (coverage fingerprints)

Ingest is idempotent per turn fingerprint. A conversation already extracted under the old UI-heavy brief will not run again until its coverage lines are dropped.

Conversation id = inbox filename without `.jsonl` (and the Cursor `conversation_id`). Coverage lives in `%LH_DATA_DIR%\graph\coverage.jsonl`; each line's `chatId` is that sanitized conversation id.

**Preferred (LearnHarness running):**

```powershell
# Example: PreVision Healthcare chat. Get the id from the inbox filename.
Get-ChildItem "$env:USERPROFILE\LearnHarness\inbox\*.jsonl" | Select-Object Name
Invoke-RestMethod -Method POST -Uri http://localhost:3000/api/cursor/reingest `
  -ContentType "application/json" `
  -Body '{"conversationId":"PASTE_CONVERSATION_ID"}'
```

That clears only that conversation's fingerprints and re-ingests the inbox file through the theory/decision extractor. Models must be configured (same as any extract). The auditor may link restated ideas to existing nodes.

**Manual:** delete `coverage.jsonl` lines whose `chatId` equals the conversation id, then restart `npm run dev` so the inbox watcher catches up — or POST `/api/cursor/ingest` with the same turns.

Do not delete the whole coverage ledger unless you intend to re-extract every Cursor conversation.

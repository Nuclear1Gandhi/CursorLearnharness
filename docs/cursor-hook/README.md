# LearnHarness capture hook

> Reference copy in this LearnHarness fork. The hook is not reimplemented here; install from this folder (or the Project store `docs/cursor-hook/`) into `%USERPROFILE%\.cursor\hooks\`. Inbox: `%USERPROFILE%\LearnHarness\inbox`. See [../local-setup.md](../local-setup.md).

Cursor is only a source. This `stop` hook records a local agent turn into an inbox file. LearnHarness reads that inbox later. The hook never quizzes, never opens a network connection, and never blocks the agent.

User-level hooks cover every local workspace on this machine. They do not run for cloud agents.

Official hook docs: [https://cursor.com/docs/agent/hooks](https://cursor.com/docs/agent/hooks)

## Install

Copy `lh-capture` to `~/.cursor/hooks/lh-capture`, make it executable (macOS/Linux), and merge the snippet in `hooks.json` into `~/.cursor/hooks.json`. User-level hooks run with working directory `~/.cursor/`, so the command is `node ./hooks/lh-capture`.

### macOS and Linux

```bash
mkdir -p ~/.cursor/hooks
cp lh-capture ~/.cursor/hooks/lh-capture
chmod +x ~/.cursor/hooks/lh-capture
```

If `~/.cursor/hooks.json` does not exist, copy `hooks.json` from this folder:

```bash
cp hooks.json ~/.cursor/hooks.json
```

If it already exists, add this `stop` entry next to any hooks you already have. Keep `"version": 1`. Do not remove other hook arrays.

```json
{
  "version": 1,
  "hooks": {
    "stop": [
      { "command": "node ./hooks/lh-capture" }
    ]
  }
}
```

Cursor reloads `hooks.json` automatically.

### Windows

Node must be on `PATH` (the same Node Cursor already uses is enough).

In PowerShell:

```powershell
New-Item -ItemType Directory -Force -Path "$HOME\.cursor\hooks" | Out-Null
Copy-Item .\lh-capture "$HOME\.cursor\hooks\lh-capture"
```

Merge the same `hooks.json` snippet into `$HOME\.cursor\hooks.json`. The command stays `node ./hooks/lh-capture`. Cursor's desktop app runs user hooks from `%USERPROFILE%\.cursor\` and pipes JSON to stdin.

`chmod` is not required on Windows.

## Inbox path

Each captured turn is one JSON line:

`~/LearnHarness/inbox/<conversation_id>.jsonl`

On Windows that is `%USERPROFILE%\LearnHarness\inbox\<conversation_id>.jsonl`.

Override the directory with `LH_INBOX_DIR`. GUI Cursor does not load your shell profile, so set it on the hook command if you need a non-default inbox:

```json
{ "command": "env LH_INBOX_DIR=/path/to/inbox node ./hooks/lh-capture" }
```

Windows (PowerShell-style env prefix Cursor can spawn):

```json
{ "command": "cmd /c \"set LH_INBOX_DIR=C:\\LearnHarness\\inbox&& node ./hooks/lh-capture\"" }
```

Line shape:

```json
{
  "conversation_id": "…",
  "generation_id": "…",
  "workspace_roots": ["…"],
  "at": "2026-01-15T12:00:00.000Z",
  "user_text": "…",
  "assistant_text": "…"
}
```

If LearnHarness is not running, the inbox just grows.

## Opt-out (one workspace)

Create an empty file at `<workspace>/.cursor/lh-ignore`. If any root in `workspace_roots` has that file, the hook exits 0 and writes nothing.

## Privacy

Stored, locally only:

- `conversation_id` and `generation_id`
- workspace root paths
- ISO-8601 timestamp
- the latest user prompt and the final assistant prose for that turn

Not stored:

- your Cursor email, even though the hook payload includes it
- tool calls, file diffs, and shell / command output
- thinking that the provider already replaced with `[REDACTED]`

Redacted before write:

- `.env`-style `KEY=value` assignments (`API_KEY=…`, `DATABASE_URL=…`, and any other `SCREAMING_SNAKE` assignment)
- `Bearer` / `Authorization: Bearer` tokens
- private-key PEM blocks
- strings that look like `sk-`, `ghp_`, `github_pat_`, `xoxb-` (and close cousins)

The script does not upload anything. Failures append a short line to `~/LearnHarness/inbox/_errors.log` (or `$LH_INBOX_DIR/_errors.log`) and still exit 0.

## Disable

Remove the `stop` entry that runs `lh-capture` from `~/.cursor/hooks.json`, or delete that file if it only contained this hook.

Temporary mute without editing JSON: set `LH_CAPTURE_DISABLED=1` on the hook command (same `env` / `cmd /c set` pattern as `LH_INBOX_DIR`).

## Tests

From this folder, with no network:

```bash
node --test lh-capture.test.mjs
```

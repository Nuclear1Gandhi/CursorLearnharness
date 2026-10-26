import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, it } from 'node:test';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.join(here, 'lh-capture');
const capture = require('./lh-capture');

const tmpDirs = [];

function makeTmp(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function writeTranscript(dir, name, lines) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
  return file;
}

function inboxLines(inboxDir, conversationId) {
  const file = path.join(inboxDir, `${conversationId}.jsonl`);
  if (!fs.existsSync(file)) {
    return [];
  }
  return fs.readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function errorLog(inboxDir) {
  const file = path.join(inboxDir, '_errors.log');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

function hookPayload(overrides = {}) {
  return {
    conversation_id: 'conv-1',
    generation_id: 'gen-1',
    hook_event_name: 'stop',
    workspace_roots: [],
    transcript_path: null,
    status: 'completed',
    loop_count: 0,
    ...overrides,
  };
}

const USER_JWT = JSON.stringify({
  role: 'user',
  generation_id: 'gen-1',
  message: {
    content: [{
      type: 'text',
      text: '<user_query>\nWhy did we pick JWT over sessions?\n</user_query>',
    }],
  },
});

const ASSISTANT_NOISY = JSON.stringify({
  role: 'assistant',
  generation_id: 'gen-1',
  message: {
    content: [
      {
        type: 'text',
        text: [
          'JWT is stateless, which fits a multi-instance API.',
          '',
          '```diff',
          '--- a/auth.js',
          '+++ b/auth.js',
          '+const jwt = require("jsonwebtoken");',
          '```',
          '',
          '```bash',
          'npm test',
          'PASS 12 tests',
          '```',
          '',
          'The trade-off is revocation.',
        ].join('\n'),
      },
      {
        type: 'tool_use',
        name: 'Shell',
        input: { command: 'npm test && cat .env' },
      },
      {
        type: 'tool_use',
        name: 'Write',
        input: { path: 'auth.js', contents: 'API_KEY=should-not-appear' },
      },
    ],
  },
});

const TURN_ENDED = JSON.stringify({ type: 'turn_ended', status: 'success' });

describe('shouldIgnore', () => {
  it('skips a workspace that has .cursor/lh-ignore', () => {
    const root = makeTmp('lh-ignore-ws-');
    fs.mkdirSync(path.join(root, '.cursor'), { recursive: true });
    fs.writeFileSync(path.join(root, '.cursor', 'lh-ignore'), '', 'utf8');
    assert.equal(capture.shouldIgnore([root]), true);
  });

  it('does not skip a workspace without the marker', () => {
    const root = makeTmp('lh-plain-ws-');
    assert.equal(capture.shouldIgnore([root]), false);
  });
});

describe('redactSecrets', () => {
  it('redacts env assignments, bearer tokens, sk-/ghp_/xoxb- strings, and PEM blocks', () => {
    const pem = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIEowIBAAKCAQEA0123456789abcdef',
      '-----END RSA PRIVATE KEY-----',
    ].join('\n');
    const raw = [
      'Set API_KEY=supersecret',
      'DATABASE_URL=postgres://user:pass@localhost/db',
      'Authorization: Bearer abcdef1234567890',
      'openai sk-abc123456789012345',
      'github ghp_abcdefghijklmnopqrstuvwx',
      'slack xoxb-1234567890-abcdefghij',
      pem,
    ].join('\n');
    const out = capture.redactSecrets(raw);
    assert.match(out, /API_KEY=\[REDACTED\]/);
    assert.match(out, /DATABASE_URL=\[REDACTED\]/);
    assert.match(out, /Bearer \[REDACTED_TOKEN\]/);
    assert.match(out, /\[REDACTED_TOKEN\]/);
    assert.equal(out.includes('supersecret'), false);
    assert.equal(out.includes('sk-abc123456789012345'), false);
    assert.equal(out.includes('ghp_abcdefghijklmnopqrstuvwx'), false);
    assert.equal(out.includes('xoxb-1234567890-abcdefghij'), false);
    assert.equal(out.includes('MIIEowIBAAKCAQEA'), false);
    assert.match(out, /\[REDACTED_PRIVATE_KEY\]/);
  });
});

describe('stripNoise / extractTurn', () => {
  it('keeps prose and drops tool calls, diffs, and shell output', () => {
    const extracted = capture.extractTurn(
      [USER_JWT, ASSISTANT_NOISY, TURN_ENDED].join('\n'),
      'gen-1',
    );
    assert.equal(extracted.userText, 'Why did we pick JWT over sessions?');
    assert.match(extracted.assistantText, /JWT is stateless/);
    assert.match(extracted.assistantText, /The trade-off is revocation/);
    assert.equal(extracted.assistantText.includes('npm test'), false);
    assert.equal(extracted.assistantText.includes('PASS 12 tests'), false);
    assert.equal(extracted.assistantText.includes('--- a/auth.js'), false);
    assert.equal(extracted.assistantText.includes('jsonwebtoken'), false);
    assert.equal(extracted.assistantText.includes('API_KEY=should-not-appear'), false);
    assert.equal(extracted.assistantText.includes('cat .env'), false);
  });

  it('selects the matching generation_id when the transcript has several turns', () => {
    const olderUser = JSON.stringify({
      role: 'user',
      generation_id: 'gen-old',
      message: { content: [{ type: 'text', text: '<user_query>old question</user_query>' }] },
    });
    const olderAsst = JSON.stringify({
      role: 'assistant',
      generation_id: 'gen-old',
      message: { content: [{ type: 'text', text: 'old answer' }] },
    });
    const extracted = capture.extractTurn(
      [olderUser, olderAsst, USER_JWT, ASSISTANT_NOISY].join('\n'),
      'gen-1',
    );
    assert.equal(extracted.userText, 'Why did we pick JWT over sessions?');
    assert.equal(extracted.assistantText.includes('old answer'), false);
  });
});

describe('processHook append', () => {
  it('appends one redacted JSON line per stop, then a second line on the next turn', () => {
    const inbox = makeTmp('lh-inbox-');
    const work = makeTmp('lh-work-');
    const transcript = writeTranscript(work, 't.jsonl', [USER_JWT, ASSISTANT_NOISY, TURN_ENDED]);
    const env = { LH_INBOX_DIR: inbox };
    const now = new Date('2026-01-15T12:00:00.000Z');
    const first = capture.processHook({
      payload: hookPayload({
        workspace_roots: [work],
        transcript_path: transcript,
      }),
      env,
      now,
    });
    assert.equal(first.wrote, true);
    const secretUser = JSON.stringify({
      role: 'user',
      generation_id: 'gen-2',
      message: {
        content: [{
          type: 'text',
          text: '<user_query>rotate API_KEY=supersecret and sk-abc123456789012345</user_query>',
        }],
      },
    });
    const secretAsst = JSON.stringify({
      role: 'assistant',
      generation_id: 'gen-2',
      message: { content: [{ type: 'text', text: 'Store it in the vault, not in git.' }] },
    });
    const transcript2 = writeTranscript(work, 't2.jsonl', [secretUser, secretAsst]);
    const second = capture.processHook({
      payload: hookPayload({
        conversation_id: 'conv-1',
        generation_id: 'gen-2',
        workspace_roots: [work],
        transcript_path: transcript2,
      }),
      env,
      now: new Date('2026-01-15T12:01:00.000Z'),
    });
    assert.equal(second.wrote, true);
    const lines = inboxLines(inbox, 'conv-1');
    assert.equal(lines.length, 2);
    assert.deepEqual(Object.keys(lines[0]).sort(), [
      'assistant_text',
      'at',
      'conversation_id',
      'generation_id',
      'user_text',
      'workspace_roots',
    ]);
    assert.equal(lines[0].conversation_id, 'conv-1');
    assert.equal(lines[0].generation_id, 'gen-1');
    assert.deepEqual(lines[0].workspace_roots, [work]);
    assert.equal(lines[0].at, '2026-01-15T12:00:00.000Z');
    assert.equal(lines[0].user_text, 'Why did we pick JWT over sessions?');
    assert.match(lines[0].assistant_text, /JWT is stateless/);
    assert.equal(lines[0].assistant_text.includes('npm test'), false);
    assert.equal(lines[1].generation_id, 'gen-2');
    assert.equal(lines[1].user_text.includes('supersecret'), false);
    assert.equal(lines[1].user_text.includes('sk-abc123456789012345'), false);
    assert.match(lines[1].user_text, /API_KEY=\[REDACTED\]/);
    assert.match(lines[1].user_text, /\[REDACTED_TOKEN\]/);
  });

  it('writes nothing when .cursor/lh-ignore is present', () => {
    const inbox = makeTmp('lh-inbox-ignore-');
    const work = makeTmp('lh-work-ignore-');
    fs.mkdirSync(path.join(work, '.cursor'), { recursive: true });
    fs.writeFileSync(path.join(work, '.cursor', 'lh-ignore'), '', 'utf8');
    const transcript = writeTranscript(work, 't.jsonl', [USER_JWT, ASSISTANT_NOISY]);
    const result = capture.processHook({
      payload: hookPayload({
        workspace_roots: [work],
        transcript_path: transcript,
      }),
      env: { LH_INBOX_DIR: inbox },
    });
    assert.equal(result.wrote, false);
    assert.equal(result.skipped, 'lh_ignore');
    assert.equal(fs.readdirSync(inbox).length, 0);
  });

  it('skips non-stop events', () => {
    const inbox = makeTmp('lh-inbox-event-');
    const result = capture.run(JSON.stringify(hookPayload({
      hook_event_name: 'afterFileEdit',
    })), { LH_INBOX_DIR: inbox });
    assert.equal(result.wrote, false);
    assert.equal(result.skipped, 'not_stop');
  });
});

describe('fail-open', () => {
  it('logs invalid stdin JSON and does not throw', () => {
    const inbox = makeTmp('lh-inbox-badjson-');
    const result = capture.run('this is not json {', { LH_INBOX_DIR: inbox });
    assert.equal(result.wrote, false);
    assert.equal(result.skipped, 'invalid_json');
    assert.match(errorLog(inbox), /invalid JSON on stdin/);
  });

  it('exits 0 from the CLI on broken input and writes _errors.log', () => {
    const inbox = makeTmp('lh-inbox-cli-');
    const spawned = spawnSync(process.execPath, [scriptPath], {
      input: '{not-json',
      encoding: 'utf8',
      env: { ...process.env, LH_INBOX_DIR: inbox },
    });
    assert.equal(spawned.status, 0);
    assert.equal(spawned.signal, null);
    assert.match(errorLog(inbox), /invalid JSON on stdin/);
    const jsonl = fs.readdirSync(inbox).filter((name) => name.endsWith('.jsonl'));
    assert.deepEqual(jsonl, []);
  });

  it('exits 0 when processHook hits a throwing fs and logs the error', () => {
    const inbox = makeTmp('lh-inbox-throw-');
    const work = makeTmp('lh-work-throw-');
    const transcript = writeTranscript(work, 't.jsonl', [USER_JWT, ASSISTANT_NOISY]);
    const throwingFs = {
      existsSync: () => false,
      statSync: fs.statSync.bind(fs),
      readFileSync: fs.readFileSync.bind(fs),
      mkdirSync: () => {
        throw new Error('disk full');
      },
      appendFileSync: () => {
        throw new Error('disk full');
      },
    };
    const result = capture.processHook({
      payload: hookPayload({
        workspace_roots: [work],
        transcript_path: transcript,
      }),
      env: { LH_INBOX_DIR: inbox },
      fsApi: throwingFs,
    });
    assert.equal(result.wrote, false);
    assert.equal(result.skipped, 'error');
    assert.match(result.error, /disk full/);
  });

  it('CLI still exits 0 when the transcript path is a directory', () => {
    const inbox = makeTmp('lh-inbox-dir-');
    const work = makeTmp('lh-work-dir-');
    const spawned = spawnSync(process.execPath, [scriptPath], {
      input: JSON.stringify(hookPayload({
        workspace_roots: [work],
        transcript_path: work,
      })),
      encoding: 'utf8',
      env: { ...process.env, LH_INBOX_DIR: inbox },
    });
    assert.equal(spawned.status, 0);
    const jsonl = fs.readdirSync(inbox).filter((name) => name.endsWith('.jsonl'));
    assert.deepEqual(jsonl, []);
  });
});

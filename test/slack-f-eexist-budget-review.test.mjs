// Round-11 mutation pin from the codex-reviewer review of lane f at 2df78f2:
// passes there, fails if a lost generation race skips the wait deadline (M2).

// M2. Ordinary contention does not force a generation-create collision after
// the wait deadline, so an EEXIST retry could skip the deadline unnoticed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sendOnChannel } from '../src/brain_train/slack/threads.mjs';

test('a lost generation race stops at the home-lock wait deadline', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'slack-eexist-budget-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const writeFile = fs.writeFile;
  const realNow = Date.now;
  let at = 1_700_000_000_000;
  let collisions = 0;
  let sends = 0;
  t.after(() => { fs.writeFile = writeFile; Date.now = realNow; });
  Date.now = () => at;
  fs.writeFile = async (...args) => {
    if (/home\.lock\.\d+$/.test(String(args[0])) && args[2]?.flag === 'wx' && collisions < 4) {
      collisions += 1;
      at += 10;
      throw Object.assign(new Error('another process won the generation'), { code: 'EEXIST' });
    }
    return writeFile(...args);
  };

  const outcome = await sendOnChannel(root, 'CFAKE', { now: Date.now, intervalMs: 1000, waitMs: 5 }, async () => {
    sends += 1;
    return { ok: true };
  });

  assert.deepEqual(outcome, { busy: true }, 'a create collision after the deadline must end this attempt');
  assert.equal(sends, 0);
});

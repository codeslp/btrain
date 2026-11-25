// Round-10 repros from the codex-reviewer review of lane f at 5959d3b,
// committed unchanged before the fix (both exceed the wait budget there).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// Attack plan: unreadable highest generation, dangling highest generation,
// and a released generation retained after sequential send/restart.
for (const mode of ['unreadable', 'dangling']) {
  test(`home lock wait is bounded with a ${mode} highest generation`, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'slack-lock-errors-'));
    t.after(() => fs.rm(root, {recursive:true, force:true}));
    const file = path.join(root, 'slack/home.lock.1');
    await fs.mkdir(path.dirname(file), {recursive:true});
    if (mode === 'unreadable') await fs.writeFile(file, 'holder', {mode:0o000});
    else await fs.symlink(path.join(root, 'missing'), file);
    const moduleUrl = new URL('../src/brain_train/slack/threads.mjs', import.meta.url).href;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { sendOnChannel } from ${JSON.stringify(moduleUrl)};
      try {
        await sendOnChannel(${JSON.stringify(root)}, 'CFAKE', {now:Date.now, intervalMs:1000, waitMs:25}, async()=>{process.exitCode=2; return {ok:true}});
      } catch {}
    `], {timeout:800, encoding:'utf8'});
    assert.equal(child.error?.code, undefined, `must return or reject within wait budget; got ${child.error?.code}`);
    assert.equal(child.status, 0, child.stderr);
  });
}

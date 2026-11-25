// Round-8 repro from the codex-reviewer review of lane f at 3ba44b7,
// committed unchanged before the fix (fails there: two overlapping sends).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sendOnChannel } from '../src/brain_train/slack/threads.mjs';

test('third sender cannot enter while stale observer moves a live lock', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'slack-third-'));
  t.after(() => fs.rm(root, {recursive:true, force:true}));
  const lock = path.join(root, 'slack/home.lock');
  await fs.mkdir(path.dirname(lock), {recursive:true});
  await fs.writeFile(lock, 'dead');
  const stale = new Date(Date.now()-60000);
  await fs.utimes(lock, stale, stale);
  const deferred = () => { let resolve; const promise = new Promise(r => resolve=r); return {promise,resolve}; };
  const observed=deferred(), resume=deferred(), started=deferred(), finish=deferred(), moved=deferred(), restore=deferred();
  const stat=fs.stat, rename=fs.rename;
  t.after(() => {fs.stat=stat; fs.rename=rename});
  let intercepted=false, interceptMove=false;
  fs.stat=async (...args) => {
    const value=await stat(...args);
    if(args[0]===lock && !intercepted) {intercepted=true; observed.resolve(); await resume.promise;}
    return value;
  };
  fs.rename=async (...args) => {
    const value=await rename(...args);
    if(args[0]===lock && interceptMove) {interceptMove=false; moved.resolve(); await restore.promise;}
    return value;
  };
  let active=0, maximum=0;
  const options={now:Date.now, intervalMs:1000, waitMs:100};
  const send=async () => {active++; maximum=Math.max(maximum,active); active--; return {ok:true};};
  const observer=sendOnChannel(root,'CFAKE',options,send);
  await observed.promise;
  const first=sendOnChannel(root,'CFAKE',options,async () => {
    active++; maximum=Math.max(maximum,active); started.resolve(); await finish.promise; active--; return {ok:true};
  });
  await started.promise;
  interceptMove=true; resume.resolve();
  await moved.promise;
  await sendOnChannel(root,'CFAKE',options,send);
  restore.resolve();
  await observer;
  finish.resolve(); await first;
  assert.equal(maximum,1,`overlapping sends: ${maximum}`);
});

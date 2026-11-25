// Round-7 repros from the codex-reviewer review of lane f at 4fb75f5,
// committed unchanged before the fix (both fail there: two overlapping sends).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { deliver } from '../src/brain_train/slack/deliver.mjs';
import { writeEntry } from '../src/brain_train/slack/outbox.mjs';
import { setThread } from '../src/brain_train/slack/threads.mjs';
import { sendOnChannel } from '../src/brain_train/slack/threads.mjs';

test('two stale home-lock observers must not send concurrently', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'slack-stale-home-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const lock = path.join(root, 'slack', 'home.lock');
  await fs.mkdir(path.dirname(lock), { recursive: true });
  await fs.writeFile(lock, 'dead-holder');
  const stale = new Date(Date.now() - 60000);
  await fs.utimes(lock, stale, stale);
  let observerReady, allowObserver, firstSending, finishFirst;
  const ready = new Promise(r => { observerReady = r });
  const resume = new Promise(r => { allowObserver = r });
  const started = new Promise(r => { firstSending = r });
  const finish = new Promise(r => { finishFirst = r });
  const stat = fs.stat;
  let observed = false;
  fs.stat = async (...args) => {
    const value = await stat(...args);
    if (args[0] === lock && !observed) {
      observed = true;
      observerReady();
      await resume;
    }
    return value;
  };
  t.after(() => { fs.stat = stat });
  let active = 0, maximum = 0, sends = 0;
  const options = { now: Date.now, intervalMs: 1000, waitMs: 200 };
  const second = sendOnChannel(root, 'CFAKE', options, async () => {
    sends++; active++; maximum = Math.max(maximum, active);
    active--; return { ok: true };
  });
  await ready;
  const first = sendOnChannel(root, 'CFAKE', options, async () => {
    sends++; active++; maximum = Math.max(maximum, active);
    firstSending();
    await finish;
    active--; return { ok: true };
  });
  await started;
  allowObserver();
  await second;
  finishFirst();
  await first;
  assert.equal(maximum, 1, `overlapping sends: ${maximum}; total sends: ${sends}`);
});

test('two repository drains recovering a stale home lock must not overlap', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'slack-stale-home-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dirs = [path.join(root, 'repo-a'), path.join(root, 'repo-b')];
  for (const dir of dirs) {
    await setThread(dir, 'f', 'claim', { channel: 'CFAKE', cardTs: '1.1' });
    await writeEntry(dir, { laneId: 'f', claimKey: 'claim', kind: 'claimed', reply: true, fields: { actor: 'claude' } });
  }
  const drain = (slackDir, callback) => deliver({
    slackDir, homeDir: root, channel: 'CFAKE', token: 'fixture', readLanes: async () => [],
    fetchImpl: async () => { await callback(); return { status: 200, json: async () => ({ ok: true, ts: '1.2' }) }; },
  });
  const lock = path.join(root, 'slack', 'home.lock');
  await fs.mkdir(path.dirname(lock), { recursive: true });
  await fs.writeFile(lock, 'dead-holder');
  const stale = new Date(Date.now() - 60000);
  await fs.utimes(lock, stale, stale);
  let observerReady, allowObserver, firstSending, finishFirst;
  const ready = new Promise(r => { observerReady = r });
  const resume = new Promise(r => { allowObserver = r });
  const started = new Promise(r => { firstSending = r });
  const finish = new Promise(r => { finishFirst = r });
  const stat = fs.stat;
  let observed = false;
  fs.stat = async (...args) => {
    const value = await stat(...args);
    if (args[0] === lock && !observed) {
      observed = true;
      observerReady();
      await resume;
    }
    return value;
  };
  t.after(() => { fs.stat = stat });
  let active = 0, maximum = 0, sends = 0;
  const options = { now: Date.now, intervalMs: 1000, waitMs: 200 };
  const second = drain(dirs[1], async () => {
    sends++; active++; maximum = Math.max(maximum, active);
    active--; return { ok: true };
  });
  await ready;
  const first = drain(dirs[0], async () => {
    sends++; active++; maximum = Math.max(maximum, active);
    firstSending();
    await finish;
    active--; return { ok: true };
  });
  await started;
  allowObserver();
  await second;
  finishFirst();
  await first;
  assert.equal(maximum, 1, `overlapping sends: ${maximum}; total sends: ${sends}`);
});

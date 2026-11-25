// Round-9 repro from the codex-reviewer review of lane f at 4ffaa6e,
// committed unchanged before the fix (fails there: two overlapping sends).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sendOnChannel } from '../src/brain_train/slack/threads.mjs';

// A contender remembers stale generation 1. Another sender takes generation 2
// and releases it. With no files left, a live sender reuses generation 1.
// Resuming the stale contender must not let it create generation 2 and send.
test('stale observer cannot supersede a reused live generation', {timeout:5000}, async t => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'slack-generation-reuse-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const file=path.join(root,'slack/home.lock.1');
  await fs.mkdir(path.dirname(file),{recursive:true});
  await fs.writeFile(file,'dead');
  const stale=new Date(Date.now()-60000);
  await fs.utimes(file,stale,stale);
  const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
  const observed=deferred(),resume=deferred(),started=deferred(),finish=deferred();
  const stat=fs.stat;
  t.after(()=>{fs.stat=stat;resume.resolve();finish.resolve();});
  let intercepted=false;
  fs.stat=async (...args)=>{
    const value=await stat(...args);
    if(args[0]===file && !intercepted){intercepted=true;observed.resolve();await resume.promise;}
    return value;
  };
  let clock=Date.now();
  const options={now:()=>clock,intervalMs:1000,waitMs:100};
  let active=0,maximum=0;
  const send=async()=>{active++;maximum=Math.max(maximum,active);active--;return {ok:true};};
  const observer=sendOnChannel(root,'CFAKE',options,send);
  await observed.promise;
  await sendOnChannel(root,'CFAKE',options,send);
  clock+=1001;
  const holder=sendOnChannel(root,'CFAKE',options,async()=>{
    active++;maximum=Math.max(maximum,active);started.resolve();await finish.promise;active--;return {ok:true};
  });
  await started.promise;
  resume.resolve();
  await observer;
  finish.resolve();await holder;
  assert.equal(maximum,1,`overlapping sends: ${maximum}`);
});

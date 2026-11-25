// Round-3 repros from the codex-reviewer review of lane f at 9599fbb,
// committed unchanged before the fixes (three fail there, one passes).

import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {deliver} from '../src/brain_train/slack/deliver.mjs';
import {writeEntry} from '../src/brain_train/slack/outbox.mjs';
import {setThread,holdChannel,reserveChannelSend,readChannelState} from '../src/brain_train/slack/threads.mjs';
async function fixture(t, channel='CFAKE') {
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'slack-f-round3-'));
 t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const homeDir=path.join(dir,'home');let at=Date.now();const calls=[];
 await setThread(dir,'f','claim',{channel,cardTs:'1.1'});
 await writeEntry(dir,{laneId:'f',claimKey:'claim',kind:'claimed',reply:true,fields:{actor:'claude'}});
 const run=(extra={})=>deliver({slackDir:dir,homeDir,channel:'CFAKE',token:'fixture',now:()=>at,sleep:async ms=>{at+=ms},readLanes:async()=>[{lane:'f',claimKey:'claim'}],fetchImpl:async(url,init)=>{calls.push({at,body:JSON.parse(init.body)});return {status:200,json:async()=>({ok:true,ts:'1.2'})}},...extra});
 return {dir,homeDir,calls,run,now:()=>at,advance:ms=>{at+=ms}};
}
test('a reservation waiting to send must honor a later shared 429',async t=>{
 const c=await fixture(t);
 await reserveChannelSend(c.homeDir,'CFAKE',{now:c.now(),intervalMs:1000});
 const result=await c.run({sleep:async ms=>{await holdChannel(c.homeDir,'CFAKE',c.now()+120000);c.advance(ms)}});
 assert.equal(c.calls.length,0,JSON.stringify({result,calls:c.calls}));
 assert.equal(result.status,'ratelimited');
});
test('budget-rejected sends must not build a phantom channel backlog',async t=>{
 const c=await fixture(t);const start=c.now();
 for(let i=0;i<5;i++) {const r=await c.run({budgetMs:500});assert.equal(r.status,'budget');}
 assert.equal(c.calls.length,0);
 const r=await c.run({budgetMs:2000});
 assert.ok(c.calls.length>0,JSON.stringify({result:r,channel:await readChannelState(c.homeDir,'CFAKE'),start}));
});
test('an existing thread uses the rate limit of its actual channel',async t=>{
 const c=await fixture(t,'COLD');
 await holdChannel(c.homeDir,'COLD',c.now()+120000);
 const result=await c.run({channel:'CNEW'});
 assert.equal(c.calls.length,0,JSON.stringify({result,calls:c.calls}));
});
test('concurrent reservations allocate separate channel slots',async t=>{
 const c=await fixture(t);const now=c.now();
 const slots=await Promise.all(Array.from({length:10},()=>reserveChannelSend(c.homeDir,'CFAKE',{now,intervalMs:1000})));
 assert.equal(new Set(slots.map(s=>s.slotAt)).size,10);
});

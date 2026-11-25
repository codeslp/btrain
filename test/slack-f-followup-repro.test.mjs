// Follow-up repros from the codex-reviewer review of lane f at d75f252,
// committed unchanged before the fixes.

import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {deliver} from '../src/brain_train/slack/deliver.mjs';
import {writeEntry,readDeliveryState,writeDeliveryState} from '../src/brain_train/slack/outbox.mjs';
import {setThread} from '../src/brain_train/slack/threads.mjs';
async function fixture(t) {
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'slack-f-followup-'));
 t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 return dir;
}
const ok=()=>({status:200,json:async()=>({ok:true,ts:'1.2'})});
test('collapsed backlog growth must preserve the first entry retry time',async t=>{
 const dir=await fixture(t);let at=Date.now();const start=at;
 await setThread(dir,'f','claim',{channel:'CFAKE',cardTs:'1.1'});
 const first=await writeEntry(dir,{laneId:'f',claimKey:'claim',kind:'claimed',reply:true,fields:{actor:'claude'},queuedAt:new Date(at-25*3600000).toISOString()});
 await writeEntry(dir,{laneId:'f',claimKey:'claim',kind:'claimed',reply:true,fields:{actor:'claude'},queuedAt:new Date(at-24*3600000+1000).toISOString()});
 let calls=0;
 const run=()=>deliver({slackDir:dir,channel:'CFAKE',token:'fixture',now:()=>at,sleep:async ms=>{at+=ms},readLanes:async()=>[{lane:'f',claimKey:'claim'}],fetchImpl:async()=>{calls++;return {status:503,json:async()=>({ok:false,error:'internal_error'})}}});
 await run();const state=await readDeliveryState(dir);
 assert.ok(Date.parse(state.entries[first.entry.id].nextTryAt)>start+2000);
 at=start+2000;await run();
 assert.equal(calls,1,'the second entry just aged into the collapse set; first retry is still in the future');
});
test('two repositories sharing a channel must share its send pace',async t=>{
 const dirs=[await fixture(t),await fixture(t)];let at=Date.now();const times=[];
 for(const dir of dirs){await setThread(dir,'f','claim',{channel:'CFAKE',cardTs:'1.1'});await writeEntry(dir,{laneId:'f',claimKey:'claim',kind:'claimed',reply:true,fields:{actor:'claude'}});}
 for(const dir of dirs)await deliver({slackDir:dir,channel:'CFAKE',token:'fixture',now:()=>at,sleep:async ms=>{at+=ms},readLanes:async()=>[{lane:'f',claimKey:'claim'}],fetchImpl:async()=>{times.push(at);return ok()}});
 assert.ok(times.length>=2);for(let i=1;i<times.length;i++)assert.ok(times[i]-times[i-1]>=1000,`same-channel sends were ${times[i]-times[i-1]} ms apart`);
});

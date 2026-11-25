// Failing repros from the codex-reviewer review of lane f (spec 024 WS3),
// committed unchanged before the fixes. Each one passes once its finding is fixed.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { callSlack } from '../src/brain_train/slack/client.mjs'
import { deliver } from '../src/brain_train/slack/deliver.mjs'
import { writeEntry, listEntries } from '../src/brain_train/slack/outbox.mjs'
import { setThread, updateBoard, readBoards } from '../src/brain_train/slack/threads.mjs'

test('response body is covered by the call timeout', async () => {
  const result = await Promise.race([
    callSlack({method:'auth.test', token:'fixture', timeoutMs:20,
      fetchImpl:async()=>({status:200,json:()=>new Promise(()=>{})})}),
    new Promise(resolve=>setTimeout(()=>resolve('still pending after 150ms'),150)),
  ])
  assert.equal(result.error, 'timeout', JSON.stringify(result))
})

async function cardCase(t, options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),'slack-card-repro-'))
  t.after(()=>fs.rm(dir,{recursive:true,force:true}))
  await setThread(dir,'f','claim',{channel:'CFAKE',cardTs:'1.1'})
  await writeEntry(dir,{laneId:'f',claimKey:'claim',kind:'sent-to-review',reply:true,fields:{actor:'claude',reviewer:'codex-reviewer'}})
  let at = Date.now()
  let updates = 0
  let fail = true
  const run = (extra={})=>deliver({slackDir:dir,homeDir:path.join(dir,'home'),channel:'CFAKE',token:'fixture',
    now:()=>at,sleep:async ms=>{at+=ms},readLanes:async()=>[{lane:'f',status:'needs-review',task:'current task'}],
    fetchImpl:async url=>{
      if(url.endsWith('chat.update')) { updates++; if(fail) return {status:429,headers:{get:()=> '120'}} }
      return {status:200,json:async()=>({ok:true,ts:'1.2'})}
    },...options,...extra})
  return {dir,run,updates:()=>updates,recover:()=>{fail=false;at+=121000}}
}

test('failed card update remains retryable after reply succeeds',async t=>{
  const c = await cardCase(t)
  await c.run()
  c.recover()
  await c.run()
  assert.equal(c.updates(),2,`pending entries: ${(await listEntries(c.dir)).length}`)
})

test('budget stop before card update preserves refresh work',async t=>{
  const c = await cardCase(t)
  const first = await c.run({budgetMs:500})
  assert.equal(first.status,'budget')
  c.recover()
  await c.run()
  assert.equal(c.updates(),1,`pending entries: ${(await listEntries(c.dir)).length}`)
})

test('concurrent board updates preserve every repository',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'slack-board-repro-'))
  t.after(()=>fs.rm(dir,{recursive:true,force:true}))
  await Promise.all(Array.from({length:10},(_,i)=>updateBoard(dir,'CFAKE',{repos:{['repo'+i]:{lines:['lane f']}}})))
  assert.equal(Object.keys((await readBoards(dir)).CFAKE.repos).length,10)
})

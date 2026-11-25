import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { decide } from '../src/brain_train/slack/decide.mjs'
import { emptyInbox, writeInbox, loadInbox } from '../src/brain_train/slack/inbox.mjs'
import { classifyInbound } from '../src/brain_train/slack/inbound.mjs'
import { parseOperatorCommand } from '../src/brain_train/slack/grammar.mjs'
const now=1700000000000, parent='1700000000.000000', channel='CFAKE'
const repo={name:'example',path:'/work/example',agents:['claude'],laneIds:['a']}
const context={repos:[repo]}
const msg=(text,ts=parent,extra={})=>{
 const heard=classifyInbound({user:'UOPER',type:'message',ts,text,...extra},{operator:'UOPER',botUserId:'UBOT'})
 return {kind:'message',channel,ts,heard,command:parseOperatorCommand(text,context)}
}
// Attack 1: a matching user plus bot identity must not authorize a command.
test('app and bot identities cannot issue commands',()=>{
 for(const extra of [{app_id:'AAPP'},{bot_id:'BBOT'}]){
  const result=decide(emptyInbox(),msg('btrain> status',parent,extra),{},now)
  assert.deepEqual(result.actions.map(a=>a.type),['ignored'])
 }
})
// Attack 2: save and reload a handled command, then replay it.
test('persisted command cannot execute twice',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'slack-review-i-'))
 try{
  const input=msg('btrain> status')
  const first=decide(emptyInbox(),input,{},now)
  assert.equal(first.actions[0].type,'command')
  writeInbox(dir,first.state)
  assert.deepEqual(decide(loadInbox(dir).state,input,{},now+1000).actions,[])
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
})
// Attack 3: prototype keys and mention tokens must fail the grammar.
test('prototype and mention injection rejected',()=>{
 for(const text of ['btrain> status __proto__=x','btrain> start owner=claude\ntask: <!here>\nfiles: src'])
  assert.equal(parseOperatorCommand(text,context).ok,false)
})
// M9: defaults expire approval before conversation closure, hiding this guard.
test('M9 keeps an idle thread while its longer-lived proposal is pending',()=>{
 const config={approvalMinutes:60,conversationMinutes:30}
 let state=decide(emptyInbox(),msg('<@UBOT> help'),config,now).state
 state=decide(state,{kind:'turn-done',channel,thread:parent},config,now+1000).state
 state=decide(state,{kind:'proposal',channel,thread:parent,ts:'1700000002.000000',proposal:{verb:'start',repo,values:{owner:'claude',task:'t',files:'src'},canonical:'btrain> start owner=claude\ntask: t\nfiles: src'}},config,now+2000).state
 const result=decide(state,{kind:'tick'},config,now+31*60000)
 assert.ok(result.state.threads[`${channel}:${parent}`],'a live pending proposal must keep its approval thread open')
 assert.equal(result.state.proposals[`${channel}:1700000002.000000`].state,'pending')
})

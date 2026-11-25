// Mutation pin M1 from the codex-reviewer review of lane f at d75f252:
// passes at HEAD, fails if the HTTP 429 branch of client.mjs is removed.

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {callSlack} from '../src/brain_train/slack/client.mjs';
// M1. Existing 429 fixtures also carry a ratelimited JSON error, masking removal of the HTTP-status branch.
test('M1: HTTP 429 with a non-JSON body preserves Retry-After',async()=>{
 const result=await callSlack({method:'chat.postMessage',token:'fixture',timeoutMs:100,fetchImpl:async()=>({status:429,headers:{get:()=> '120'},json:async()=>{throw new SyntaxError('not JSON')}})});
 assert.equal(result.error,'ratelimited');assert.equal(result.retryAfterMs,120000);
});

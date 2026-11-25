// Round-4 repro from the codex-reviewer review of lane f at bbd9589,
// committed unchanged before the fix (fails there: two sends 0 ms apart).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { deliver } from '../src/brain_train/slack/deliver.mjs'
import { writeEntry } from '../src/brain_train/slack/outbox.mjs'
import { setThread, reserveChannelSend } from '../src/brain_train/slack/threads.mjs'

test('a sender waking late must not send alongside a newer reservation', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'slack-f-late-slot-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const homeDir = path.join(root, 'home')
  const dirs = [path.join(root, 'a'), path.join(root, 'b')]
  let at = Date.now()
  const sends = []
  for (const dir of dirs) {
    await setThread(dir, 'f', 'claim', { channel: 'CFAKE', cardTs: '1.1' })
    await writeEntry(dir, { laneId: 'f', claimKey: 'claim', kind: 'claimed', reply: true, fields: { actor: 'claude' } })
  }
  const run = (dir, sleep) => deliver({
    slackDir: dir, homeDir, channel: 'CFAKE', token: 'fixture',
    now: () => at, sleep, readLanes: async () => [],
    fetchImpl: async () => {
      sends.push(at)
      return { status: 200, json: async () => ({ ok: true, ts: '1.2' }) }
    },
  })
  // One prior call at t0 forces repository A to reserve t0+1000 and wait.
  await reserveChannelSend(homeDir, 'CFAKE', { now: at, intervalMs: 1000 })
  const result = await run(dirs[0], async () => {
    // A wakes a second late (e.g. process suspension). B has already sent
    // using its newer t0+2000 slot when A resumes.
    at += 2000
    assert.equal((await run(dirs[1], async ms => { at += ms })).status, 'done')
  })
  assert.equal(result.status, 'done')
  assert.equal(sends.length, 2)
  assert.ok(sends[1] - sends[0] >= 1000, `same-channel sends were ${sends[1] - sends[0]} ms apart`)
})

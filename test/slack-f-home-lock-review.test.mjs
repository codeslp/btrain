// Round-5 repro from the codex-reviewer review of lane f at 59c99b5,
// committed unchanged before the fix (fails there: two sends 0 ms apart).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { deliver } from '../src/brain_train/slack/deliver.mjs'
import { writeEntry } from '../src/brain_train/slack/outbox.mjs'
import { setThread } from '../src/brain_train/slack/threads.mjs'

test('time spent waiting for the home lock must count toward the channel pace', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'slack-f-home-wait-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const homeDir = path.join(root, 'home')
  const homeLock = path.join(homeDir, 'slack', 'home.lock')
  let at = Date.now()
  const calls = []
  const dirs = [path.join(root, 'a'), path.join(root, 'b')]
  for (const dir of dirs) {
    await setThread(dir, 'f', 'claim', { channel: 'CFAKE', cardTs: '1.1' })
    await writeEntry(dir, { laneId: 'f', claimKey: 'claim', kind: 'claimed', reply: true, fields: { actor: 'claude' } })
  }
  await fs.mkdir(path.dirname(homeLock), { recursive: true })
  await fs.writeFile(homeLock, 'another-home-writer')
  // Deterministic schedule: A has already passed now() into the claim and
  // found home.lock held. The holder releases it 1500 ms later. Only the
  // clock and the other holder's release are controlled; send code is real.
  const stat = fs.stat
  let waited = false
  fs.stat = async (...args) => {
    const result = await stat(...args)
    if (args[0] === homeLock && !waited) {
      waited = true
      at += 1500
      await fs.unlink(homeLock)
    }
    return result
  }
  t.after(() => { fs.stat = stat })
  for (const dir of dirs) {
    const result = await deliver({
      slackDir: dir, homeDir, channel: 'CFAKE', token: 'fixture',
      now: () => at, sleep: async ms => { at += ms }, readLanes: async () => [],
      fetchImpl: async () => {
        calls.push(at)
        return { status: 200, json: async () => ({ ok: true, ts: '1.2' }) }
      },
    })
    assert.equal(result.status, 'done')
  }
  assert.ok(waited, 'the first sender encountered the home lock')
  assert.equal(calls.length, 2)
  assert.ok(calls[1] - calls[0] >= 1000, `same-channel sends were ${calls[1] - calls[0]} ms apart`)
})

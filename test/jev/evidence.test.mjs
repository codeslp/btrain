import { describe, it } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createSourceSnapshot, appendSourceSnapshots, appendSourceOutcome, readEvidence } from "../../src/brain_train/jev/evidence.mjs"

describe("Jev source evidence", () => {
  const comment = { surface: "review", id: 42, author: "review-bot", body: "Fix the test", url: "https://example.test/42", at: "2026-09-01T10:00:00Z", state: "CHANGES_REQUESTED", reviewedCommit: "a".repeat(40) }

  it("does not turn a later capture head into an event-time head", () => {
    const row = createSourceSnapshot({ repository: "o/r", prNumber: 7, laneId: "a", comment, capturedAt: "2026-09-01T10:05:00Z", captureHead: "b".repeat(40) })
    assert.equal(row.eventHead, "unknown")
    assert.equal(row.captureHead, "b".repeat(40))
    assert.equal(row.reviewedCommit, "a".repeat(40))
    assert.equal(row.body, undefined)
    assert.equal(row.sourceHash.length, 64)
    const sameTemplate = createSourceSnapshot({ repository: "o/r", prNumber: 8, laneId: "a", comment: { ...comment, id: 43, body: "Fix the test" }, capturedAt: "2026-09-01T10:05:00Z" })
    assert.equal(row.templateGroup, sameTemplate.templateGroup)
    const sanitized = createSourceSnapshot({ repository: "o/r", prNumber: 7, laneId: "a", comment: { ...comment, url: "https://user:pass@example.test/42?token=secret#part" }, capturedAt: "2026-09-01T10:05:00Z" })
    assert.equal(sanitized.sourceRef, "https://example.test/42")
  })

  it("appends each source once and records later outcomes without rewriting the source", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "btrain-jev-evidence-"))
    try {
      const row = createSourceSnapshot({ repository: "o/r", prNumber: 7, laneId: "a", comment, capturedAt: "2026-09-01T10:05:00Z" })
      assert.equal(await appendSourceSnapshots(root, [row, row]), 1)
      assert.equal(await appendSourceSnapshots(root, [row]), 0)
      await appendSourceOutcome(root, { sourceId: row.id, outcome: "repaired", observedAt: "2026-09-02T10:00:00Z", evidenceRef: "https://example.test/repair" })
      const evidence = await readEvidence(root)
      assert.equal(evidence.snapshots.length, 1)
      assert.deepEqual(evidence.outcomes.map((entry) => entry.outcome), ["pending", "repaired"])
      assert.equal(evidence.snapshots[0].eventHead, "unknown")
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})

import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { audit, captureManifest } from "./audit-corpus.mjs"

test("corpus audit excludes inline findings and author replies, deduplicates repeated source IDs, and groups commit variants", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "jev-corpus-audit-"))
  try {
    const directory = path.join(root, ".btrain", "pr-comments")
    await fs.mkdir(directory, { recursive: true })
    const message = (id, surface, author, body) => JSON.stringify({ id, surface, author, body })
    await fs.writeFile(path.join(directory, "lane-a-1.jsonl"), [
      message(1, "issue", "reviewer[bot]", "No findings. Reviewed commit: abcdef1234567 <details><summary>ℹ️ About Codex in GitHub</summary>footer</details>"),
      message(2, "inline", "reviewer[bot]", "Fix this bug"),
      message(3, "issue", "author", "@reviewer review"),
    ].join("\n"))
    await fs.writeFile(path.join(directory, "lane-b-1.jsonl"), [
      message(1, "issue", "reviewer[bot]", "No findings. Reviewed commit: abcdef1234567 <details><summary>ℹ️ About Codex in GitHub</summary>footer</details>"),
      message(4, "issue", "reviewer[bot]", "No findings. Reviewed commit: 9876543fedcba <details><summary>ℹ️ About Codex in GitHub</summary>other footer</details>"),
    ].join("\n"))

    const result = await audit([{ name: "sample", root }], ["reviewer[bot]"])
    assert.equal(result.overall.rows, 5)
    assert.equal(result.overall.uniqueCommentIds, 4)
    assert.equal(result.overall.reviewerBotRows, 4)
    assert.equal(result.overall.textSurfaceRows, 3)
    assert.equal(result.overall.uniqueTextCommentIds, 2)
    assert.equal(result.overall.coreMessageFamilies, 1)
    assert.equal(result.overall.bySurface.inline, 1)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("corpus audit preserves distinct review findings inside details blocks", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "jev-corpus-audit-"))
  try {
    const directory = path.join(root, ".btrain", "pr-comments")
    await fs.mkdir(directory, { recursive: true })
    const body = (finding) => `Review summary <details><summary>Finding</summary>${finding}</details>`
    await fs.writeFile(path.join(directory, "lane-a-1.jsonl"), [
      JSON.stringify({ id: 1, surface: "review", author: "reviewer[bot]", body: body("Fix lock ownership") }),
      JSON.stringify({ id: 2, surface: "review", author: "reviewer[bot]", body: body("Add a timeout guard") }),
    ].join("\n"))

    const result = await audit([{ name: "sample", root }], ["reviewer[bot]"])
    assert.equal(result.overall.coreMessageFamilies, 2)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("corpus audit preserves different verdicts in structured review status cards", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "jev-corpus-audit-"))
  try {
    const directory = path.join(root, ".btrain", "pr-comments")
    await fs.mkdir(directory, { recursive: true })
    const card = (status) => `<!-- codex-pull-request-review-summary --> Review status: ${status}`
    await fs.writeFile(path.join(directory, "lane-a-1.jsonl"), [
      JSON.stringify({ id: 1, surface: "issue", author: "reviewer[bot]", body: card("clear") }),
      JSON.stringify({ id: 2, surface: "issue", author: "reviewer[bot]", body: card("feedback") }),
    ].join("\n"))

    const result = await audit([{ name: "sample", root }], ["reviewer[bot]"])
    assert.equal(result.overall.coreMessageFamilies, 2)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("corpus audit fails on a comment without source identity", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "jev-corpus-audit-"))
  try {
    const directory = path.join(root, ".btrain", "pr-comments")
    await fs.mkdir(directory, { recursive: true })
    await fs.writeFile(path.join(directory, "lane-a-1.jsonl"), '{"surface":"issue","author":"reviewer[bot]","body":"No issues"}\n')
    await assert.rejects(audit([{ name: "sample", root }], ["reviewer[bot]"]), /Missing comment identity/)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("source fingerprint changes when eligibility metadata changes without changing ID or body", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "jev-corpus-audit-"))
  try {
    const directory = path.join(root, ".btrain", "pr-comments")
    await fs.mkdir(directory, { recursive: true })
    const file = path.join(directory, "lane-a-1.jsonl")
    const original = {
      id: 1,
      surface: "issue",
      author: "reviewer[bot]",
      body: "No findings",
      state: "COMMENTED",
      commit_id: "abcdef1234567",
    }
    async function fingerprint(record) {
      await fs.writeFile(file, `${JSON.stringify(record)}\n`)
      return (await audit([{ name: "sample", root }], ["reviewer[bot]"])).sourceFingerprint
    }
    const baseline = await fingerprint(original)
    for (const changed of [
      { author: "author" },
      { surface: "inline" },
      { state: "APPROVED" },
      { commit_id: "9876543fedcba" },
    ]) {
      assert.notEqual(await fingerprint({ ...original, ...changed }), baseline)
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("audit manifest ignores later backfilled comments and files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "jev-corpus-audit-"))
  try {
    const directory = path.join(root, ".btrain", "pr-comments")
    await fs.mkdir(directory, { recursive: true })
    const older = { id: 1, surface: "issue", author: "reviewer[bot]", body: "No findings", at: "2026-09-23T12:00:00Z" }
    const newer = { id: 2, surface: "issue", author: "reviewer[bot]", body: "New finding", at: "2026-09-23T12:01:00Z" }
    const repo = [{ name: "sample", root }]
    await fs.writeFile(path.join(directory, "lane-a-1.jsonl"), `${JSON.stringify(older)}\n`)
    const manifest = await captureManifest(repo, "2026-09-24T22:00:00Z")
    assert.equal(manifest.repos.sample[0].lineCount, 1)
    const frozen = await audit(repo, ["reviewer[bot]"], { manifest })
    await fs.appendFile(path.join(directory, "lane-a-1.jsonl"), `${JSON.stringify(newer)}\n`)
    await fs.writeFile(path.join(directory, "lane-b-2.jsonl"), `${JSON.stringify(newer)}\n`)
    const rerun = await audit(repo, ["reviewer[bot]"], { manifest })

    assert.deepEqual(rerun, frozen)
    assert.equal(rerun.repos.sample.files, 1)
    await fs.appendFile(path.join(directory, "lane-a-1.jsonl"), "\n")
    assert.deepEqual(await audit(repo, ["reviewer[bot]"], { manifest }), frozen)
    await fs.writeFile(path.join(directory, "lane-a-1.jsonl"), `${JSON.stringify({ ...older, author: "author" })}\n${JSON.stringify(newer)}\n`)
    await assert.rejects(audit(repo, ["reviewer[bot]"], { manifest }), /Manifest source mismatch/)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

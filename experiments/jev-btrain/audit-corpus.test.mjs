import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { audit } from "./audit-corpus.mjs"

test("corpus audit excludes inline findings and author replies, deduplicates repeated source IDs, and groups commit variants", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "jev-corpus-audit-"))
  try {
    const directory = path.join(root, ".btrain", "pr-comments")
    await fs.mkdir(directory, { recursive: true })
    const message = (id, surface, author, body) => JSON.stringify({ id, surface, author, body })
    await fs.writeFile(path.join(directory, "lane-a-1.jsonl"), [
      message(1, "issue", "reviewer[bot]", "No findings. Reviewed commit: abcdef1234567 <details>footer</details>"),
      message(2, "inline", "reviewer[bot]", "Fix this bug"),
      message(3, "issue", "author", "@reviewer review"),
    ].join("\n"))
    await fs.writeFile(path.join(directory, "lane-b-1.jsonl"), [
      message(1, "issue", "reviewer[bot]", "No findings. Reviewed commit: abcdef1234567 <details>footer</details>"),
      message(4, "issue", "reviewer[bot]", "No findings. Reviewed commit: 9876543fedcba <details>other footer</details>"),
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

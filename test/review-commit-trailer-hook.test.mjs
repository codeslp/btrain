// Spec 023 FR-13 and FR-14 through src/brain_train/review/commit-trailer-hook.mjs
// (part of task T037). The hook is installed into a temporary repository and
// run by git itself.
import { describe, it, after } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { COMMIT_MSG_HOOK_MARKER, readTrailerAgent, renderCommitMsgHook } from "../src/brain_train/review/commit-trailer-hook.mjs"
import { withoutLaneScope } from "./helpers/runner-scope.mjs"

const exec = promisify(execFile)
const roots = []
after(async () => Promise.all(roots.map((root) => fs.rm(root, { recursive: true, force: true }))))

async function repoWithHook() {
  const repo = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "btrain-trailer-hook-")))
  roots.push(repo)
  await exec("git", ["init", "-q", "-b", "main", repo])
  await exec("git", ["-C", repo, "config", "user.email", "test@example.com"])
  await exec("git", ["-C", repo, "config", "user.name", "Test Bot"])
  const hook = path.join(repo, ".git", "hooks", "commit-msg")
  await fs.writeFile(hook, renderCommitMsgHook(), "utf8")
  await fs.chmod(hook, 0o755)
  let count = 0
  return {
    repo,
    async commit(message, { agent, extraArgs = [], env = {} } = {}) {
      count += 1
      await fs.writeFile(path.join(repo, `f${count}.txt`), `${count}\n`)
      await exec("git", ["-C", repo, "add", "-A"])
      const base = withoutLaneScope()
      delete base.BRAIN_TRAIN_AGENT
      await exec("git", ["-C", repo, "commit", "-q", "-m", message, ...extraArgs], { env: { ...base, ...(agent !== undefined ? { BTRAIN_AGENT: agent } : {}), ...env } })
      return (await exec("git", ["-C", repo, "log", "-1", "--format=%B"])).stdout.trim()
    },
  }
}

describe("the managed commit-msg hook", () => {
  it("carries its marker, so btrain can recognize the hook it manages", () => {
    const text = renderCommitMsgHook()
    assert.ok(text.startsWith(`#!/bin/sh\n${COMMIT_MSG_HOOK_MARKER}\n`))
  })

  it("appends the trailer for the agent in BTRAIN_AGENT", async () => {
    const { commit } = await repoWithHook()
    assert.equal(await commit("Fix the bug", { agent: "codex-reviewer" }), "Fix the bug\n\nBtrain-Agent: codex-reviewer")
  })

  it("falls back to BRAIN_TRAIN_AGENT", async () => {
    const { commit } = await repoWithHook()
    assert.equal(await commit("Fix", { env: { BRAIN_TRAIN_AGENT: "claude" } }), "Fix\n\nBtrain-Agent: claude")
  })

  it("adds nothing with no agent set, and nothing when the trailer is already there", async () => {
    const { commit } = await repoWithHook()
    assert.equal(await commit("Plain"), "Plain")
    assert.equal(await commit("Typed\n\nBtrain-Agent: claude", { agent: "codex-reviewer" }), "Typed\n\nBtrain-Agent: claude")
  })

  it("is skipped by --no-verify, so the commit has no trailer", async () => {
    const { commit } = await repoWithHook()
    assert.equal(await commit("Bypass", { agent: "codex-reviewer", extraArgs: ["--no-verify"] }), "Bypass")
  })

  it("cannot be made to write a second trailer through the agent name", async () => {
    const { commit } = await repoWithHook()
    const message = await commit("Fix", { agent: "codex-reviewer\nBtrain-Agent: owner" })
    assert.equal(message, "Fix\n\nBtrain-Agent: codex-reviewerBtrain-Agentowner")
    assert.equal(readTrailerAgent(message), "codex-reviewerBtrain-Agentowner")
  })

  it("keeps other trailers", async () => {
    const { commit } = await repoWithHook()
    const message = await commit("Fix\n\nCo-Authored-By: A <a@example.com>", { agent: "gem" })
    assert.equal(message, "Fix\n\nCo-Authored-By: A <a@example.com>\nBtrain-Agent: gem")
    assert.equal(readTrailerAgent(message), "gem")
  })
})

describe("readTrailerAgent", () => {
  it("reads the last Btrain-Agent trailer line, and only a whole line", () => {
    assert.equal(readTrailerAgent("Fix\n\nBtrain-Agent: codex-reviewer"), "codex-reviewer")
    assert.equal(readTrailerAgent("Fix\n\nbtrain-agent:claude\nBtrain-Agent: gem"), "gem")
    assert.equal(readTrailerAgent("Mentions Btrain-Agent: gem in prose"), "")
    assert.equal(readTrailerAgent(""), "")
  })
})

import { describe, it, beforeEach } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

import { resolveStateRoot, isLinkedWorktree, clearStateRootCache } from "../src/brain_train/worktree.mjs"

const exec = promisify(execFile)

async function git(cwd, ...args) {
  const { stdout } = await exec("git", ["-C", cwd, ...args])
  return stdout.trim()
}

async function makeRepo(root) {
  const repo = path.join(root, "repo")
  await exec("git", ["init", "-q", "-b", "main", repo])
  await git(repo, "config", "user.email", "test@example.com")
  await git(repo, "config", "user.name", "Test Bot")
  await git(repo, "config", "commit.gpgsign", "false")
  await fs.writeFile(path.join(repo, "README.md"), "base\n")
  await git(repo, "add", "-A")
  await git(repo, "commit", "-q", "-m", "base")
  return repo
}

async function withTmp(fn) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "btrain-worktree-state-")))
  try {
    await fn(root)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}

describe("resolveStateRoot", () => {
  beforeEach(() => clearStateRootCache())

  it("is the checkout itself for a primary checkout", async () => {
    await withTmp(async (root) => {
      const repo = await makeRepo(root)
      assert.equal(resolveStateRoot(repo), repo)
      assert.equal(isLinkedWorktree(repo), false)
    })
  })

  it("is the main worktree for a linked worktree, wherever it lives", async () => {
    await withTmp(async (root) => {
      const repo = await makeRepo(root)
      const sibling = path.join(root, "sibling-worktree")
      const nested = path.join(repo, ".claude", "worktrees", "nested")
      await git(repo, "worktree", "add", "-q", "-b", "lane-x", sibling)
      await git(repo, "worktree", "add", "-q", "-b", "lane-y", nested)
      assert.equal(resolveStateRoot(sibling), repo)
      assert.equal(resolveStateRoot(nested), repo)
      assert.equal(isLinkedWorktree(sibling), true)
      // The primary checkout is unaffected by having linked worktrees.
      assert.equal(resolveStateRoot(repo), repo)
    })
  })

  it("is the checkout itself for a submodule-style .git pointer with no commondir", async () => {
    await withTmp(async (root) => {
      const outer = await makeRepo(root)
      const inner = path.join(root, "inner")
      await fs.mkdir(path.join(outer, ".git", "modules", "inner"), { recursive: true })
      await fs.mkdir(inner)
      await fs.writeFile(path.join(inner, ".git"), `gitdir: ${path.join(outer, ".git", "modules", "inner")}\n`)
      assert.equal(resolveStateRoot(inner), inner)
    })
  })

  it("is the directory itself when it is not a git checkout", async () => {
    await withTmp(async (root) => {
      const plain = path.join(root, "plain")
      await fs.mkdir(plain)
      assert.equal(resolveStateRoot(plain), plain)
    })
  })

  it("does not follow a pointer whose common dir is not a working tree's .git", async () => {
    await withTmp(async (root) => {
      const bare = path.join(root, "bare.git")
      await exec("git", ["init", "-q", "--bare", bare])
      const fake = path.join(root, "fake")
      await fs.mkdir(path.join(bare, "worktrees", "fake"), { recursive: true })
      await fs.writeFile(path.join(bare, "worktrees", "fake", "commondir"), "../..\n")
      await fs.mkdir(fake)
      await fs.writeFile(path.join(fake, ".git"), `gitdir: ${path.join(bare, "worktrees", "fake")}\n`)
      assert.equal(resolveStateRoot(fake), fake)
    })
  })
})

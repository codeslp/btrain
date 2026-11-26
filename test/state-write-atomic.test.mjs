import { describe, it } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { acquireLocks, readLockRegistry } from "../src/brain_train/core.mjs"

const exec = promisify(execFile)

// Readers such as `btrain handoff wait` do not take the registry lock. Before
// state writes were atomic, a reader that ran during a rewrite could see a
// truncated locks.json, and readJson then returned an empty registry. The
// waiter woke on that torn state and printed "locked files: (none)".
describe("state file writes", () => {
  it("never show a concurrent reader a torn lock registry", async () => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "btrain-atomic-write-"))
    try {
      await exec("git", ["init", "-q", repoRoot])
      const files = Array.from({ length: 200 }, (_, index) => `src/module-${index}/`)
      await acquireLocks(repoRoot, "a", "claude", files)

      let writing = true
      let reads = 0
      const torn = []
      const writer = (async () => {
        try {
          for (let round = 0; round < 150; round += 1) {
            await acquireLocks(repoRoot, "a", "claude", files)
          }
        } finally {
          writing = false
        }
      })()
      const reader = (async () => {
        while (writing) {
          const registry = await readLockRegistry(repoRoot)
          reads += 1
          if (registry.locks.length !== files.length) {
            torn.push(registry.locks.length)
          }
        }
      })()
      await Promise.all([writer, reader])

      assert.ok(reads > 0, "the reader never ran")
      assert.deepEqual(torn, [], `${torn.length} of ${reads} reads saw a torn registry`)
      const leftovers = (await fs.readdir(path.join(repoRoot, ".btrain"))).filter((name) => name.endsWith(".tmp"))
      assert.deepEqual(leftovers, [])
    } finally {
      await fs.rm(repoRoot, { recursive: true, force: true })
    }
  })

  // Red-team cases from the lane a review: the atomic rename must keep the
  // old write's file identity rules.
  async function withStateDir(run) {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "btrain-atomic-write-"))
    try {
      const stateDir = path.join(repoRoot, ".btrain")
      await fs.mkdir(stateDir)
      await run(repoRoot, stateDir)
    } finally {
      await fs.rm(repoRoot, { recursive: true, force: true })
    }
  }

  it("keep an existing file's mode", () => withStateDir(async (repoRoot, stateDir) => {
    const target = path.join(stateDir, "locks.json")
    await fs.writeFile(target, '{"version":1,"locks":[]}')
    await fs.chmod(target, 0o640)
    await acquireLocks(repoRoot, "a", "claude", ["src/"])
    assert.equal((await fs.stat(target)).mode & 0o777, 0o640)
  }))

  it("write through a symlink and keep the link", () => withStateDir(async (repoRoot, stateDir) => {
    await fs.writeFile(path.join(stateDir, "actual.json"), '{"version":1,"locks":[]}')
    await fs.symlink("actual.json", path.join(stateDir, "locks.json"))
    await acquireLocks(repoRoot, "a", "claude", ["src/"])
    assert.equal(await fs.readlink(path.join(stateDir, "locks.json")), "actual.json")
    assert.equal(JSON.parse(await fs.readFile(path.join(stateDir, "actual.json"), "utf8")).locks.length, 1)
  }))

  it("create the target of a dangling symlink and keep the link", () => withStateDir(async (repoRoot, stateDir) => {
    await fs.symlink("actual.json", path.join(stateDir, "locks.json"))
    await acquireLocks(repoRoot, "a", "claude", ["src/"])
    assert.equal(await fs.readlink(path.join(stateDir, "locks.json")), "actual.json")
    assert.equal(JSON.parse(await fs.readFile(path.join(stateDir, "actual.json"), "utf8")).locks.length, 1)
  }))

  it("create the last target of a dangling symlink chain and keep every link", () => withStateDir(async (repoRoot, stateDir) => {
    await fs.symlink("middle.json", path.join(stateDir, "locks.json"))
    await fs.symlink("actual.json", path.join(stateDir, "middle.json"))
    await acquireLocks(repoRoot, "a", "claude", ["src/"])
    assert.equal(await fs.readlink(path.join(stateDir, "locks.json")), "middle.json")
    assert.equal(await fs.readlink(path.join(stateDir, "middle.json")), "actual.json")
    assert.equal(JSON.parse(await fs.readFile(path.join(stateDir, "actual.json"), "utf8")).locks.length, 1)
  }))

  it("leave no temporary file when the rename fails", () => withStateDir(async (repoRoot, stateDir) => {
    await fs.mkdir(path.join(stateDir, "locks.json"))
    await assert.rejects(acquireLocks(repoRoot, "a", "claude", ["src/"]))
    assert.deepEqual((await fs.readdir(stateDir)).filter((name) => name.endsWith(".tmp")), [])
  }))

  it("keep an executable file executable", () => withStateDir(async (repoRoot, stateDir) => {
    const target = path.join(stateDir, "locks.json")
    await fs.writeFile(target, '{"version":1,"locks":[]}')
    await fs.chmod(target, 0o755)
    await acquireLocks(repoRoot, "a", "claude", ["src/"])
    assert.equal((await fs.stat(target)).mode & 0o777, 0o755)
  }))

  it("write through a symlink whose target has a long valid name", () => withStateDir(async (repoRoot, stateDir) => {
    // 235 characters: valid, but a temporary name built by appending a pid
    // and a UUID to it would pass the 255-byte component limit.
    const longName = `${"x".repeat(230)}.json`
    await fs.writeFile(path.join(stateDir, longName), '{"version":1,"locks":[]}')
    await fs.symlink(longName, path.join(stateDir, "locks.json"))
    await acquireLocks(repoRoot, "a", "claude", ["src/"])
    assert.equal(await fs.readlink(path.join(stateDir, "locks.json")), longName)
    assert.equal(JSON.parse(await fs.readFile(path.join(stateDir, longName), "utf8")).locks.length, 1)
  }))

  it("use a fresh temporary file for every write, next to the target", () => withStateDir(async (repoRoot, stateDir) => {
    const renames = []
    const rename = fs.rename
    fs.rename = async (from, to) => {
      if (path.basename(to) === "locks.json") renames.push({ from, to })
      return rename(from, to)
    }
    try {
      await acquireLocks(repoRoot, "a", "claude", ["src/"])
      await acquireLocks(repoRoot, "a", "claude", ["src/", "test/"])
    } finally {
      fs.rename = rename
    }
    assert.equal(renames.length, 2)
    assert.notEqual(path.basename(renames[0].from), path.basename(renames[1].from))
    for (const { from, to } of renames) {
      assert.equal(path.dirname(from), path.dirname(to))
      assert.equal(await fs.realpath(path.dirname(to)), await fs.realpath(stateDir))
      assert.ok(path.basename(from).length <= 64, from)
    }
  }))

  it("refuse a symlink loop and leave the link in place", () => withStateDir(async (repoRoot, stateDir) => {
    const link = path.join(stateDir, "locks.json")
    await fs.symlink("locks.json", link)
    await assert.rejects(acquireLocks(repoRoot, "a", "claude", ["src/"]), { code: "ELOOP" })
    assert.equal(await fs.readlink(link), "locks.json")
    assert.deepEqual((await fs.readdir(stateDir)).filter((name) => name.endsWith(".tmp")), [])
  }))

  it("refuse to write when resolving the target fails for a reason other than a missing file", () => withStateDir(async (repoRoot, stateDir) => {
    const target = path.join(stateDir, "locks.json")
    await fs.writeFile(target, '{"version":1,"locks":[]}')
    const realpath = fs.realpath
    fs.realpath = async (candidate, ...rest) => {
      if (candidate === target) throw Object.assign(new Error("EACCES: injected"), { code: "EACCES" })
      return realpath(candidate, ...rest)
    }
    try {
      await assert.rejects(acquireLocks(repoRoot, "a", "claude", ["src/"]), { code: "EACCES" })
    } finally {
      fs.realpath = realpath
    }
    assert.equal(await fs.readFile(target, "utf8"), '{"version":1,"locks":[]}')
  }))

  it("refuse to write when reading a dangling link fails for a reason other than a missing file", () => withStateDir(async (repoRoot, stateDir) => {
    const link = path.join(stateDir, "locks.json")
    await fs.symlink("actual.json", link)
    const readlink = fs.readlink
    fs.readlink = async (candidate, ...rest) => {
      if (candidate === link) throw Object.assign(new Error("EACCES: injected"), { code: "EACCES" })
      return readlink(candidate, ...rest)
    }
    try {
      await assert.rejects(acquireLocks(repoRoot, "a", "claude", ["src/"]), { code: "EACCES" })
    } finally {
      fs.readlink = readlink
    }
    assert.equal(await fs.readlink(link), "actual.json")
    assert.deepEqual((await fs.readdir(stateDir)).filter((name) => name.endsWith(".tmp")), [])
    await assert.rejects(fs.stat(path.join(stateDir, "actual.json")), { code: "ENOENT" })
  }))

  // Red-team case from the round-3 review (and the PR #138 bot): a relative
  // dangling link must resolve against the directory the filesystem follows,
  // not the lexical path through a symlinked parent.
  it("resolve a dangling relative link from its physical parent directory", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "btrain-parent-link-"))
    try {
      const repo = path.join(root, "repo")
      const external = path.join(root, "external")
      await fs.mkdir(repo)
      await fs.mkdir(path.join(external, "state"), { recursive: true })
      await fs.symlink(path.join(external, "state"), path.join(repo, ".btrain"))
      await fs.symlink("../registry.json", path.join(external, "state", "locks.json"))

      await acquireLocks(repo, "a", "claude", ["src/"])

      assert.equal((await readLockRegistry(repo)).locks.length, 1, "the acquired lock must be visible to other agents")
      assert.equal(JSON.parse(await fs.readFile(path.join(external, "registry.json"), "utf8")).locks.length, 1)
      assert.equal(await fs.readlink(path.join(external, "state", "locks.json")), "../registry.json")
      await assert.rejects(fs.stat(path.join(repo, "registry.json")), { code: "ENOENT" })
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it("refuse to write when resolving a dangling link's parent fails for a reason other than a missing directory", () => withStateDir(async (repoRoot, stateDir) => {
    const link = path.join(stateDir, "locks.json")
    await fs.symlink("actual.json", link)
    const realpath = fs.realpath
    fs.realpath = async (candidate, ...rest) => {
      if (candidate === stateDir) throw Object.assign(new Error("EACCES: injected"), { code: "EACCES" })
      return realpath(candidate, ...rest)
    }
    try {
      await assert.rejects(acquireLocks(repoRoot, "a", "claude", ["src/"]), { code: "EACCES" })
    } finally {
      fs.realpath = realpath
    }
    assert.equal(await fs.readlink(link), "actual.json")
    await assert.rejects(fs.stat(path.join(stateDir, "actual.json")), { code: "ENOENT" })
    assert.deepEqual((await fs.readdir(stateDir)).filter((name) => name.endsWith(".tmp")), [])
  }))

  it("keep the committed file and remove the temporary file when the write fails partway", () => withStateDir(async (repoRoot, stateDir) => {
    await acquireLocks(repoRoot, "a", "claude", ["src/"])
    const target = path.join(stateDir, "locks.json")
    const before = await fs.readFile(target, "utf8")
    const writeFile = fs.writeFile
    fs.writeFile = async (candidate, ...rest) => {
      if (path.basename(String(candidate)).startsWith(".btrain-write-")) {
        await writeFile(candidate, "partial")
        throw Object.assign(new Error("ENOSPC: injected"), { code: "ENOSPC" })
      }
      return writeFile(candidate, ...rest)
    }
    try {
      await assert.rejects(acquireLocks(repoRoot, "a", "claude", ["other/"]), { code: "ENOSPC" })
    } finally {
      fs.writeFile = writeFile
    }
    assert.equal(await fs.readFile(target, "utf8"), before)
    assert.deepEqual((await fs.readdir(stateDir)).filter((name) => name.endsWith(".tmp")), [])
  }))

  // Red-team case from round 7 (and the PR #138 bot): ".." inside a dangling
  // link's target must step out of the directory a symlinked component points
  // to, as the filesystem does, not cancel that component lexically.
  it("follow a symlinked directory before '..' inside a dangling link's target", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "btrain-traversal-"))
    try {
      const repo = path.join(root, "repo")
      const state = path.join(repo, ".btrain")
      const external = path.join(root, "external")
      await fs.mkdir(state, { recursive: true })
      await fs.mkdir(path.join(external, "nested"), { recursive: true })
      await fs.symlink(path.join(external, "nested"), path.join(state, "dir"))
      await fs.symlink("dir/../registry.json", path.join(state, "locks.json"))

      await acquireLocks(repo, "a", "claude", ["src/"])

      assert.equal((await readLockRegistry(repo)).locks.length, 1, "the acquired lock must be visible through locks.json")
      assert.equal(JSON.parse(await fs.readFile(path.join(external, "registry.json"), "utf8")).locks.length, 1)
      assert.equal(await fs.readlink(path.join(state, "locks.json")), "dir/../registry.json")
      await assert.rejects(fs.stat(path.join(state, "registry.json")), { code: "ENOENT" })
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  // Red-team cases from round 8: writes through a dangling link fail where a
  // native write fails, and multi-hop chains keep physical traversal.
  it("refuse a dangling target that steps through a missing directory, as a native write does", () => withStateDir(async (repoRoot, stateDir) => {
    const link = path.join(stateDir, "locks.json")
    await fs.symlink("missing/../registry.json", link)
    await assert.rejects(fs.writeFile(link, "native"), { code: "ENOENT" })
    await assert.rejects(acquireLocks(repoRoot, "a", "claude", ["src/"]), { code: "ENOENT" })
    await assert.rejects(fs.stat(path.join(stateDir, "registry.json")), { code: "ENOENT" })
    assert.equal(await fs.readlink(link), "missing/../registry.json")
    assert.deepEqual((await fs.readdir(stateDir)).filter((name) => name.endsWith(".tmp")), [])
  }))

  it("refuse a dangling target with a trailing slash and keep the link", () => withStateDir(async (repoRoot, stateDir) => {
    const link = path.join(stateDir, "locks.json")
    await fs.symlink("missing/", link)
    await assert.rejects(acquireLocks(repoRoot, "a", "claude", ["src/"]))
    assert.equal(await fs.readlink(link), "missing/")
    await assert.rejects(fs.stat(path.join(stateDir, "missing")), { code: "ENOENT" })
  }))

  it("follow several dangling hops through a symlinked directory", () => withStateDir(async (repoRoot, stateDir) => {
    await fs.mkdir(path.join(stateDir, "actual"))
    await fs.symlink("actual", path.join(stateDir, "dir"))
    await fs.symlink("dir/middle", path.join(stateDir, "locks.json"))
    await fs.symlink("../registry.json", path.join(stateDir, "actual", "middle"))
    await acquireLocks(repoRoot, "a", "claude", ["src/"])
    assert.equal((await readLockRegistry(repoRoot)).locks.length, 1)
    assert.equal(await fs.readlink(path.join(stateDir, "actual", "middle")), "../registry.json")
    assert.equal(JSON.parse(await fs.readFile(path.join(stateDir, "registry.json"), "utf8")).locks.length, 1)
  }))

  // Security review on PR #138: a user who can write the state directory but
  // not a privileged btrain's other files must not be able to redirect the
  // temporary file. Mode changes go through the open descriptor, and a
  // temporary path replaced after creation is refused before the rename.
  it("never apply the preserved mode to the temporary file by path", () => withStateDir(async (repoRoot, stateDir) => {
    const target = path.join(stateDir, "locks.json")
    await fs.writeFile(target, '{"version":1,"locks":[]}')
    await fs.chmod(target, 0o640)
    const pathChmods = []
    const chmod = fs.chmod
    fs.chmod = async (candidate, ...rest) => {
      if (path.basename(String(candidate)).startsWith(".btrain-write-")) pathChmods.push(candidate)
      return chmod(candidate, ...rest)
    }
    try {
      await acquireLocks(repoRoot, "a", "claude", ["src/"])
    } finally {
      fs.chmod = chmod
    }
    assert.deepEqual(pathChmods, [])
    assert.equal((await fs.stat(target)).mode & 0o777, 0o640)
  }))

  it("refuse a temporary file that was replaced after it was created", () => withStateDir(async (repoRoot, stateDir) => {
    const target = path.join(stateDir, "locks.json")
    await fs.writeFile(target, '{"version":1,"locks":[]}')
    await fs.chmod(target, 0o640)
    const victim = path.join(path.dirname(stateDir), "victim.txt")
    await fs.writeFile(victim, "victim")
    await fs.chmod(victim, 0o600)
    async function swap(candidate) {
      await fs.rm(candidate, { force: true })
      await fs.symlink(victim, candidate)
    }
    const isTemporary = (candidate) => path.basename(String(candidate)).startsWith(".btrain-write-")
    const open = fs.open
    const writeFile = fs.writeFile
    fs.open = async (candidate, ...rest) => {
      const handle = await open(candidate, ...rest)
      if (isTemporary(candidate)) await swap(candidate)
      return handle
    }
    fs.writeFile = async (candidate, ...rest) => {
      await writeFile(candidate, ...rest)
      if (isTemporary(candidate)) await swap(candidate)
    }
    try {
      await assert.rejects(acquireLocks(repoRoot, "a", "claude", ["src/"]))
    } finally {
      fs.open = open
      fs.writeFile = writeFile
    }
    assert.equal((await fs.stat(victim)).mode & 0o777, 0o600)
    assert.equal(await fs.readFile(victim, "utf8"), "victim")
    assert.equal((await fs.lstat(target)).isSymbolicLink(), false)
    assert.equal(await fs.readFile(target, "utf8"), '{"version":1,"locks":[]}')
  }))
})

// `btrain init` and `btrain register` record a repository in the global
// registry (`$BRAIN_TRAIN_HOME/repos.json`, default `~/.btrain/repos.json`).
// Scratch runs by reviewers and probes (red-team repros, mutation rounds,
// stand-in review setup scripts) ran `btrain init` on throwaway directories
// without isolating that home. By 2026-10-14 the user's real registry held 33
// temporary repositories, and one of them carried an advisory event that the
// spec 015 FR-5 audit had to count. These tests pin the guard:
//
// - With BRAIN_TRAIN_HOME unset, a repository under a temporary root is not
//   registered in the default registry. The output says why and how to
//   register it in a scratch home.
// - An explicit BRAIN_TRAIN_HOME keeps today's behavior: the repository is
//   registered there.
// - BTRAIN_NO_REGISTER=1 skips registration everywhere.
// - `btrain init` inside a linked worktree registers the repository (its main
//   checkout) once, as `btrain register` already does, not the worktree path.
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"

const exec = promisify(execFile)
const CLI = path.resolve("src/brain_train/cli.mjs")

async function scratch() {
  // realpath: macOS hands out /var/folders/... for a /private/var/folders/... directory.
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "btrain-registry-scratch-")))
}

function cleanEnv(overrides = {}) {
  const env = { ...process.env }
  for (const name of [
    "BRAIN_TRAIN_HOME",
    "BTRAIN_TEST_DEFAULT_HOME",
    "BTRAIN_NO_REGISTER",
    "BTRAIN_AGENT",
    "BRAIN_TRAIN_AGENT",
    "BTRAIN_LANE",
    "BTRAIN_LANE_LOCKED",
    "BTRAIN_REPO",
  ]) {
    delete env[name]
  }
  return { ...env, ...overrides }
}

async function btrain(args, env) {
  try {
    const { stdout, stderr } = await exec("node", [CLI, ...args], { env, maxBuffer: 4 * 1024 * 1024 })
    return { code: 0, stdout, stderr }
  } catch (error) {
    return { code: typeof error.code === "number" ? error.code : 1, stdout: error.stdout || "", stderr: error.stderr || "" }
  }
}

const GIT_IDENTITY = ["-c", "user.name=t", "-c", "user.email=t@t"]

async function gitRepo(dir) {
  await fs.mkdir(dir, { recursive: true })
  await exec("git", ["init", "-q", dir])
  await exec("git", ["-C", dir, ...GIT_IDENTITY, "commit", "-q", "--allow-empty", "-m", "init"])
  return dir
}

async function readRegistry(home) {
  try {
    return JSON.parse(await fs.readFile(path.join(home, "repos.json"), "utf8")).repos
  } catch (error) {
    if (error.code === "ENOENT") return null
    throw error
  }
}

async function exists(target) {
  try {
    await fs.stat(target)
    return true
  } catch (error) {
    if (error.code === "ENOENT") return false
    throw error
  }
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

describe("registry guard for scratch repositories", () => {
  it("keeps a temporary repository out of the default registry when BRAIN_TRAIN_HOME is unset", async () => {
    const root = await scratch()
    try {
      const fakeHome = path.join(root, "user-home")
      await fs.mkdir(fakeHome)
      const repo = await gitRepo(path.join(root, "repo"))
      const env = cleanEnv({ HOME: fakeHome, USERPROFILE: fakeHome })

      const init = await btrain(["init", repo, "--tracked"], env)
      assert.equal(init.code, 0, init.stderr)
      assert.match(init.stdout, /^Initialized /m)
      assert.match(init.stdout, /^registry: skipped \(.*temporary directory.*BRAIN_TRAIN_HOME is not set\)/m)
      assert.match(init.stdout, /BRAIN_TRAIN_HOME=/)
      assert.ok(await exists(path.join(repo, ".btrain", "project.toml")), "the repository is still scaffolded")
      // Templates still come from the default home, so it may exist; the
      // registry must not name the scratch repository.
      const defaultHome = path.join(fakeHome, ".btrain")
      assert.deepEqual((await readRegistry(defaultHome)) ?? [], [], "the default registry stays empty")

      const register = await btrain(["register", repo], env)
      assert.equal(register.code, 0, register.stderr)
      assert.match(register.stdout, /^Not registered /m)
      assert.match(register.stdout, /^registry: skipped \(.*temporary directory/m)
      assert.deepEqual((await readRegistry(defaultHome)) ?? [], [], "register leaves the default registry empty too")
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it("registers a temporary repository in an explicit BRAIN_TRAIN_HOME, as before", async () => {
    const root = await scratch()
    try {
      const home = path.join(root, "home")
      const repo = await gitRepo(path.join(root, "repo"))
      const env = cleanEnv({ HOME: path.join(root, "user-home"), BRAIN_TRAIN_HOME: home })

      const init = await btrain(["init", repo, "--tracked"], env)
      assert.equal(init.code, 0, init.stderr)
      assert.match(init.stdout, new RegExp(`^home: ${escapeRegExp(home)}$`, "m"))
      assert.doesNotMatch(init.stdout, /registry: skipped/)
      assert.deepEqual((await readRegistry(home)).map((entry) => entry.path), [repo])

      const register = await btrain(["register", repo], env)
      assert.equal(register.code, 0, register.stderr)
      assert.match(register.stdout, /^Registered /m)
      assert.deepEqual((await readRegistry(home)).map((entry) => entry.path), [repo], "re-registering updates the one entry")
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it("skips registration everywhere when BTRAIN_NO_REGISTER=1, even with an explicit home", async () => {
    const root = await scratch()
    try {
      const home = path.join(root, "home")
      const repo = await gitRepo(path.join(root, "repo"))
      const env = cleanEnv({ HOME: path.join(root, "user-home"), BRAIN_TRAIN_HOME: home, BTRAIN_NO_REGISTER: "1" })

      const init = await btrain(["init", repo, "--tracked"], env)
      assert.equal(init.code, 0, init.stderr)
      assert.match(init.stdout, /^registry: skipped \(BTRAIN_NO_REGISTER=1\)/m)
      const register = await btrain(["register", repo], env)
      assert.equal(register.code, 0, register.stderr)
      assert.match(register.stdout, /^registry: skipped \(BTRAIN_NO_REGISTER=1\)/m)
      assert.deepEqual((await readRegistry(home)) ?? [], [], "the registry names no repository")
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it("registers the main checkout once when btrain init runs inside a linked worktree", async () => {
    const root = await scratch()
    try {
      const home = path.join(root, "home")
      const main = await gitRepo(path.join(root, "main"))
      const env = cleanEnv({ HOME: path.join(root, "user-home"), BRAIN_TRAIN_HOME: home })

      const first = await btrain(["init", main, "--tracked"], env)
      assert.equal(first.code, 0, first.stderr)
      await exec("git", ["-C", main, "add", "-A"])
      await exec("git", ["-C", main, ...GIT_IDENTITY, "commit", "-q", "-m", "scaffold"])
      const worktree = path.join(root, "wt")
      await exec("git", ["-C", main, "worktree", "add", "-q", "-b", "wt", worktree])

      const second = await btrain(["init", worktree, "--tracked"], env)
      assert.equal(second.code, 0, second.stderr)
      const entries = await readRegistry(home)
      assert.deepEqual(entries.map((entry) => entry.path), [main], "one entry, for the main checkout")
      assert.equal(entries[0].project_config_path, path.join(main, ".btrain", "project.toml"))
      assert.ok(entries[0].handoff_path.startsWith(`${main}${path.sep}`), `handoff path ${entries[0].handoff_path} lives in the main checkout`)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it("matches an existing registry entry by real path, so a symlinked spelling does not duplicate it", async () => {
    // macOS spells the same temp directory /var/folders/... and
    // /private/var/folders/...; git records the real path for a worktree's
    // main checkout. An entry recorded through either spelling is updated, not
    // duplicated.
    const root = await scratch()
    try {
      const home = path.join(root, "home")
      const repo = await gitRepo(path.join(root, "repo"))
      const alias = path.join(root, "alias")
      await fs.symlink(repo, alias)
      const env = cleanEnv({ HOME: path.join(root, "user-home"), BRAIN_TRAIN_HOME: home })

      const init = await btrain(["init", alias, "--tracked"], env)
      assert.equal(init.code, 0, init.stderr)
      const register = await btrain(["register", repo], env)
      assert.equal(register.code, 0, register.stderr)
      const entries = await readRegistry(home)
      assert.equal(entries.length, 1, `expected one entry, got ${entries.map((entry) => entry.path).join(", ")}`)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})

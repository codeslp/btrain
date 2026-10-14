import { describe, it } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { execFile } from "node:child_process"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { TEST_DEFAULT_HOME_MARKER, withGitAutoMaintenanceOff } from "./helpers/git-test-env.mjs"

const exec = promisify(execFile)
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const PRELOAD = "--import ./test/helpers/git-test-env.mjs"

describe("git test env preload", () => {
  it("is preloaded by every npm script that runs node --test", async () => {
    // Without it, git's detached auto-maintenance repacks a test repo while its
    // teardown fs.rm runs, and the suite fails with ENOTEMPTY on the CI runners.
    const pkg = JSON.parse(await fs.readFile(path.join(repoRoot, "package.json"), "utf8"))
    const testScripts = Object.entries(pkg.scripts).filter(([, script]) => /\bnode\b.*--test\b/.test(script))
    assert.ok(testScripts.length >= 5, `expected the test scripts, found ${testScripts.map(([name]) => name).join(", ")}`)
    for (const [name, script] of testScripts) {
      assert.ok(script.includes(`node ${PRELOAD} --test`), `${name} must run node ${PRELOAD} --test`)
    }
  })

  it("is preloaded by the CI step that runs node --test directly", async () => {
    const workflow = await fs.readFile(path.join(repoRoot, ".github/workflows/test.yml"), "utf8")
    const direct = workflow.split("\n").filter((line) => /^\s*node .*--test\b/.test(line))
    assert.ok(direct.length >= 1, "expected the runtime-compatibility job's direct node --test line")
    for (const line of direct) {
      assert.ok(line.includes(`node ${PRELOAD} --test`), `CI line must preload the helper: ${line.trim()}`)
    }
  })

  it("is preloaded by the formal advisory's own node --test runs", async () => {
    // formal-advisory.yml runs scripts/formal_advisory.mjs directly, outside npm.
    const script = await fs.readFile(path.join(repoRoot, "scripts/formal_advisory.mjs"), "utf8")
    assert.doesNotMatch(script, /\["--test", "test\//, "build node --test args with nodeTestArgs so the preload applies")
    assert.match(script, /"--test", "--import", `\.\/\$\{preload\}`/)
  })

  it("appends after existing GIT_CONFIG entries and does not stack on a second load", () => {
    const base = {
      PATH: "/bin",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.autocrlf",
      GIT_CONFIG_VALUE_0: "false",
    }
    const once = withGitAutoMaintenanceOff(base)
    assert.deepEqual(once, {
      ...base,
      GIT_CONFIG_COUNT: "3",
      GIT_CONFIG_KEY_1: "maintenance.auto",
      GIT_CONFIG_VALUE_1: "false",
      GIT_CONFIG_KEY_2: "gc.auto",
      GIT_CONFIG_VALUE_2: "0",
    })
    assert.deepEqual(withGitAutoMaintenanceOff(once), once)
    assert.equal(base.GIT_CONFIG_COUNT, "1", "the input env must not be mutated")
  })

  it("turns auto-maintenance off for a git child that inherits the env", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "btrain-git-test-env-"))
    try {
      await exec("git", ["init", "-q", dir])
      const env = withGitAutoMaintenanceOff({ ...process.env, GIT_CONFIG_COUNT: "0" })
      const read = async (key) => (await exec("git", ["-C", dir, "config", "--get", key], { env })).stdout.trim()
      assert.equal(await read("maintenance.auto"), "false")
      assert.equal(await read("gc.auto"), "0")
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  // A test or ad hoc probe that runs `btrain init` without BRAIN_TRAIN_HOME
  // used to register its throwaway repo in the user's real ~/.btrain registry.
  // The preload now gives each process its own scratch home unless the caller
  // chose one.
  describe("default btrain home", () => {
    const PRINT_HOME =
      `console.log(JSON.stringify({ home: process.env.BRAIN_TRAIN_HOME || null, marker: process.env.${TEST_DEFAULT_HOME_MARKER} || null }))`

    async function preloaded(envOverrides) {
      const env = { ...process.env }
      delete env.BRAIN_TRAIN_HOME
      delete env[TEST_DEFAULT_HOME_MARKER]
      const { stdout } = await exec(process.execPath, ["--import", "./test/helpers/git-test-env.mjs", "-e", PRINT_HOME], {
        cwd: repoRoot,
        env: { ...env, ...envOverrides },
      })
      return JSON.parse(stdout)
    }

    it("is set for the current test process, and is never ~/.btrain", () => {
      const home = process.env.BRAIN_TRAIN_HOME
      assert.ok(home, "BRAIN_TRAIN_HOME is set")
      assert.notEqual(path.resolve(home), path.join(os.homedir(), ".btrain"))
    })

    it("creates a per-process scratch home under the temp directory when none is set, and removes it on exit", async () => {
      const { home, marker } = await preloaded({})
      assert.ok(home, "a home is assigned")
      assert.equal(marker, home, "the marker records that the preload chose it")
      const tmp = await fs.realpath(os.tmpdir())
      assert.ok(home.startsWith(`${tmp}${path.sep}`) || home.startsWith(`${os.tmpdir()}${path.sep}`), `${home} is under the temp directory`)
      await assert.rejects(fs.stat(home), { code: "ENOENT" }, "the scratch home is removed when the process exits")
    })

    it("keeps an explicit BRAIN_TRAIN_HOME", async () => {
      const chosen = path.join(os.tmpdir(), "btrain-explicit-home-not-created")
      const { home, marker } = await preloaded({ BRAIN_TRAIN_HOME: chosen })
      assert.equal(home, chosen)
      assert.equal(marker, null)
    })

    it("gives each process its own home instead of sharing one inherited from an ancestor preload", async () => {
      // node --test hands its env to every test file process, and files run
      // in parallel, so a shared default home would race on repos.json.
      const inherited = path.join(os.tmpdir(), "btrain-ancestor-default-home")
      const { home, marker } = await preloaded({ BRAIN_TRAIN_HOME: inherited, [TEST_DEFAULT_HOME_MARKER]: inherited })
      assert.notEqual(home, inherited)
      assert.equal(marker, home)
    })
  })
})

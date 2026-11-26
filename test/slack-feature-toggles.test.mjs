// Spec 024 T007 and spec 025 T011: the `slack` and `slack_listen` features
// are explicit-only. Unlike the older toggles, a repository with no
// `[features]` table, or no key for them, has them off.
import { after, describe, it } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import {
  FEATURES,
  getAllOnFeatureMap,
  getEffectiveFeatureMap,
  getFeatureMapFromConfig,
  getNewRepoFeatureBase,
  isFeatureEnabled,
} from "../src/brain_train/repo_mode.mjs"
import { readProjectConfig } from "../src/brain_train/core.mjs"
import { isSlackEnabled, isSlackListenEnabled } from "../src/brain_train/slack/config.mjs"

const exec = promisify(execFile)
const CLI_PATH = path.resolve("src/brain_train/cli.mjs")
const EXPLICIT = ["slack", "slack_listen"]

const roots = []
after(async () => Promise.all(roots.map((root) => fs.rm(root, { recursive: true, force: true }))))

describe("explicit-only features (repo_mode.mjs)", () => {
  it("declares slack and slack_listen off by default and explicit-only", () => {
    for (const id of EXPLICIT) {
      const feature = FEATURES.find((entry) => entry.id === id)
      assert.ok(feature, id)
      assert.equal(feature.localDefault, false, id)
      assert.equal(feature.explicitOnly, true, id)
    }
    assert.deepEqual(FEATURES.filter((feature) => feature.explicitOnly).map((feature) => feature.id), EXPLICIT, "no older toggle changes its rule")
  })

  it("is on only when its [features] key is exactly true", () => {
    for (const id of EXPLICIT) {
      assert.equal(isFeatureEnabled({ name: "legacy" }, id), false, `${id}: no [features] table`)
      assert.equal(isFeatureEnabled({ features: { formal: true } }, id), false, `${id}: no key`)
      assert.equal(isFeatureEnabled({ features: { [id]: true } }, id), true, `${id}: true`)
      // The project TOML parser keeps a comment after an unquoted value.
      assert.equal(isFeatureEnabled({ features: { [id]: "true # on" } }, id), true, `${id}: true with a comment`)
      for (const value of [false, "true", "yes", 1, ""]) {
        assert.equal(isFeatureEnabled({ features: { [id]: value } }, id), false, `${id}: ${JSON.stringify(value)}`)
      }
    }
  })

  it("agrees with slack/config.mjs, which decides the toggle for slack/ itself", () => {
    for (const config of [{}, { features: {} }, { features: { slack: true, slack_listen: "true # on" } }, { features: { slack: "true", slack_listen: false } }]) {
      assert.equal(isFeatureEnabled(config, "slack"), isSlackEnabled(config), JSON.stringify(config))
      assert.equal(isFeatureEnabled(config, "slack_listen"), isSlackListenEnabled(config), JSON.stringify(config))
    }
  })

  it("is off in the all-on map, the effective map of a legacy repo, and every new-repo base", () => {
    for (const map of [getAllOnFeatureMap(), getEffectiveFeatureMap({ name: "legacy" }), getNewRepoFeatureBase("local"), getNewRepoFeatureBase("tracked"), getFeatureMapFromConfig({ features: {} })]) {
      for (const id of EXPLICIT) assert.equal(map[id], false, id)
    }
    assert.equal(getAllOnFeatureMap().formal, true, "the older toggles stay on in the all-on map")
  })
})

describe("btrain features with the explicit-only toggles", () => {
  function cliEnv(home) {
    const env = { ...process.env }
    for (const key of ["BTRAIN_AGENT", "BRAIN_TRAIN_AGENT", "BTRAIN_LANE", "BTRAIN_LANE_LOCKED", "BTRAIN_REPO", "BTRAIN_LOOP_ACTIVE"]) delete env[key]
    return { ...env, BRAIN_TRAIN_HOME: home, BTRAIN_NO_REVIEW_DISPATCH: "1", CI: "true" }
  }

  async function btrain(args, { cwd, home }) {
    try {
      const result = await exec("node", [CLI_PATH, ...args], { cwd, env: cliEnv(home), maxBuffer: 5 * 1024 * 1024 })
      return { stdout: result.stdout, stderr: result.stderr, code: 0 }
    } catch (error) {
      return { stdout: error.stdout || "", stderr: error.stderr || "", code: typeof error.code === "number" ? error.code : 1 }
    }
  }

  async function legacyRepo() {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "btrain-slack-toggles-")))
    roots.push(root)
    const home = path.join(root, "home")
    const repo = path.join(root, "repo")
    await exec("git", ["init", "-q", "-b", "main", repo])
    const init = await btrain(["init", repo, "--tracked", "--core-only", "--no-hooks"], { cwd: repo, home })
    assert.equal(init.code, 0, init.stderr)
    // A repository from before spec 022: no [features] table.
    const tomlPath = path.join(repo, ".btrain", "project.toml")
    const toml = await fs.readFile(tomlPath, "utf8")
    await fs.writeFile(tomlPath, toml.replace(/\n\[features\][\s\S]*?(?=\n\[|$)/, "\n"))
    assert.equal((await readProjectConfig(repo)).features, undefined)
    return { repo, home, tomlPath }
  }

  it("has the publisher and the listener off in a repository with no [features] table, and says so", async () => {
    const { repo, home } = await legacyRepo()
    const json = await btrain(["features", "list", "--repo", repo, "--format", "json"], { cwd: repo, home })
    const map = JSON.parse(json.stdout).features
    assert.equal(map.slack, false)
    assert.equal(map.slack_listen, false)
    assert.equal(map.formal, true, "older toggles keep the legacy rule")
    const text = await btrain(["features", "list", "--repo", repo], { cwd: repo, home })
    assert.doesNotMatch(text.stdout, /every feature is on \(/)
    assert.match(text.stdout, /except slack and slack_listen/)
    assert.match(text.stdout, /\[ \] slack /)
    assert.match(text.stdout, /\[ \] slack_listen /)
  })

  it("writes no slack = true when another feature is disabled there", async () => {
    const { repo, home, tomlPath } = await legacyRepo()
    const disabled = await btrain(["features", "disable", "formal", "--repo", repo], { cwd: repo, home })
    assert.equal(disabled.code, 0, disabled.stderr)
    const toml = await fs.readFile(tomlPath, "utf8")
    assert.doesNotMatch(toml, /^slack = true/m)
    assert.doesNotMatch(toml, /^slack_listen = true/m)
    const config = await readProjectConfig(repo)
    assert.equal(isSlackEnabled(config), false)
    assert.equal(isSlackListenEnabled(config), false)

    const enabled = await btrain(["features", "enable", "slack", "--repo", repo], { cwd: repo, home })
    assert.equal(enabled.code, 0, enabled.stderr)
    const after = await readProjectConfig(repo)
    assert.equal(isSlackEnabled(after), true)
    assert.equal(isSlackListenEnabled(after), false, "publishing does not turn listening on")
  })
})

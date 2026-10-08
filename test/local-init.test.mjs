// Spec 022: local-only `btrain init` (the new default) and feature toggles.
import { withoutLaneScope } from "./helpers/runner-scope.mjs"
import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { getStartupSnapshot, readProjectConfig } from "../src/brain_train/core.mjs"
import {
  FEATURE_IDS,
  applyFeatureAnswer,
  getDefaultFeatureMap,
  isFeatureEnabled,
  orderAgentsForReviewer,
  parseAgentList,
  resolveFeatureMap,
  runInitQuestions,
  shouldPromptForInit,
  upsertFeaturesTable,
} from "../src/brain_train/repo_mode.mjs"

const exec = promisify(execFile)
const CLI = path.resolve("src/brain_train/cli.mjs")

let scratch

async function makeRepo(name = "repo") {
  const repo = await fs.mkdtemp(path.join(scratch, `${name}-`))
  await exec("git", ["init", "-q", "--initial-branch=main", repo])
  await exec("git", ["-C", repo, "config", "user.email", "t@t.test"])
  await exec("git", ["-C", repo, "config", "user.name", "t"])
  await fs.writeFile(path.join(repo, "app.js"), "console.log(1)\n")
  await exec("git", ["-C", repo, "add", "."])
  await exec("git", ["-C", repo, "commit", "-qm", "seed"])
  return repo
}

// BRAIN_TRAIN_HOME lives outside the repo so it never shows in git status.
async function btrain(args, cwd, env = {}) {
  try {
    const result = await exec("node", [CLI, ...args], {
      cwd,
      env: {
        ...withoutLaneScope(),
        BRAIN_TRAIN_HOME: path.join(scratch, "home"),
        BTRAIN_DASHBOARD_DISABLED: "1",
        ...env,
      },
      maxBuffer: 5 * 1024 * 1024,
    })
    return { stdout: result.stdout.trim(), stderr: result.stderr.trim(), code: 0 }
  } catch (error) {
    return {
      stdout: error.stdout?.trim() || "",
      stderr: error.stderr?.trim() || "",
      code: typeof error.code === "number" ? error.code : 1,
    }
  }
}

async function git(repo, args, env = {}) {
  try {
    const result = await exec("git", ["-C", repo, ...args], { env: { ...withoutLaneScope(), ...env } })
    return { stdout: result.stdout, stderr: result.stderr, code: 0 }
  } catch (error) {
    return { stdout: error.stdout || "", stderr: error.stderr || "", code: typeof error.code === "number" ? error.code : 1 }
  }
}

async function porcelain(repo) {
  return (await git(repo, ["status", "--porcelain", "--untracked-files=all"])).stdout.trim()
}

async function exists(filePath) {
  try {
    await fs.lstat(filePath)
    return true
  } catch {
    return false
  }
}

async function workLaneEndToEnd(repo) {
  let result = await btrain(
    ["handoff", "claim", "--lane", "a", "--task", "Change app", "--owner", "claude", "--reviewer", "codex", "--files", "app.js"],
    repo,
    { BTRAIN_AGENT: "claude" },
  )
  assert.equal(result.code, 0, result.stderr)
  await fs.appendFile(path.join(repo, "app.js"), "console.log(2)\n")
  await git(repo, ["add", "app.js"])
  assert.equal((await git(repo, ["commit", "-qm", "change app"], { BTRAIN_AGENT: "claude" })).code, 0)
  result = await btrain(
    [
      "handoff", "update", "--lane", "a", "--status", "needs-review", "--actor", "claude",
      "--base", "HEAD~1", "--preflight", "--changed", "app.js", "--verification", "manual run",
      "--gap", "none", "--why", "test", "--review-ask", "check it",
    ],
    repo,
    { BTRAIN_AGENT: "claude" },
  )
  assert.equal(result.code, 0, result.stderr)
  return result
}

before(async () => {
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), "btrain-local-init-"))
})

after(async () => {
  await fs.rm(scratch, { recursive: true, force: true })
})

describe("local-only init (default)", () => {
  it("creates only .btrain/ plus one .gitignore line, and a full lane leaves nothing else to commit", async () => {
    const repo = await makeRepo()
    const result = await btrain(["init", repo, "--agents", "claude,codex", "--reviewer", "codex"], repo)
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stdout, /storage: local/)
    assert.match(result.stdout, /\.btrain\/AGENTS\.md/)

    assert.equal(await fs.readFile(path.join(repo, ".gitignore"), "utf8"), ".btrain/\n")
    for (const tracked of ["AGENTS.md", "CLAUDE.md", "GEMINI.md", ".claude", ".agents", ".codex", "scripts", "agentchattr"]) {
      assert.equal(await exists(path.join(repo, tracked)), false, `${tracked} must not be created in local mode`)
    }
    for (const local of [".btrain/project.toml", ".btrain/locks.json", ".btrain/AGENTS.md", ".btrain/collab/HANDOFF_A.md"]) {
      assert.equal(await exists(path.join(repo, local)), true, `${local} should exist`)
    }
    assert.equal(await porcelain(repo), "?? .gitignore")

    const config = await readProjectConfig(repo)
    assert.equal(config.storage, "local")
    assert.equal(config.lanes.a.handoff_path, ".btrain/collab/HANDOFF_A.md")
    assert.deepEqual(config.agents.active, ["claude", "codex"])
    assert.equal(config.agents.reviewer_default, "codex")

    await workLaneEndToEnd(repo)
    const resolved = await btrain(["handoff", "resolve", "--lane", "a", "--summary", "ok", "--actor", "codex"], repo, { BTRAIN_AGENT: "codex" })
    assert.equal(resolved.code, 0, resolved.stderr)
    assert.equal(await porcelain(repo), "?? .gitignore")
  })

  it("is idempotent: re-running init never duplicates the ignore line or dirties the tree", async () => {
    const repo = await makeRepo()
    await fs.writeFile(path.join(repo, ".gitignore"), "node_modules/")
    await git(repo, ["add", ".gitignore"])
    await git(repo, ["commit", "-qm", "ignore"])
    assert.equal((await btrain(["init", repo], repo)).code, 0)
    const first = await fs.readFile(path.join(repo, ".gitignore"), "utf8")
    assert.equal(first, "node_modules/\n.btrain/\n")
    const again = await btrain(["init", repo], repo)
    assert.equal(again.code, 0, again.stderr)
    assert.match(again.stdout, /already ignores \.btrain\//)
    assert.equal(await fs.readFile(path.join(repo, ".gitignore"), "utf8"), first)
    assert.equal(await porcelain(repo), "M .gitignore")
  })

  it("--exclude-local leaves zero tracked footprint via .git/info/exclude", async () => {
    const repo = await makeRepo()
    const result = await btrain(["init", repo, "--exclude-local"], repo)
    assert.equal(result.code, 0, result.stderr)
    assert.equal(await exists(path.join(repo, ".gitignore")), false)
    assert.match(await fs.readFile(path.join(repo, ".git", "info", "exclude"), "utf8"), /^\.btrain\/$/m)
    assert.equal(await porcelain(repo), "")
    await workLaneEndToEnd(repo)
    assert.equal(await porcelain(repo), "")
  })

  it("--reviewer without --agents sets only reviewer_default on a new repo", async () => {
    const repo = await makeRepo("reviewer-only-new")
    const baseline = await makeRepo("reviewer-only-baseline")
    assert.equal((await btrain(["init", baseline, "--yes"], baseline)).code, 0)
    const result = await btrain(["init", repo, "--reviewer", "codex", "--yes"], repo)
    assert.equal(result.code, 0, result.stderr)
    const config = await readProjectConfig(repo)
    assert.deepEqual(config.agents.active, (await readProjectConfig(baseline)).agents.active)
    assert.equal(config.agents.reviewer_default, "codex")
  })

  it("--reviewer without --agents keeps an existing repo's agents and lanes", async () => {
    const repo = await makeRepo("reviewer-only-existing")
    assert.equal((await btrain(["init", repo, "--agents", "claude,codex", "--yes"], repo)).code, 0)
    const before = await readProjectConfig(repo)
    const result = await btrain(["init", repo, "--reviewer", "claude", "--yes"], repo)
    assert.equal(result.code, 0, result.stderr)
    const config = await readProjectConfig(repo)
    assert.deepEqual(config.agents.active, ["claude", "codex"])
    assert.deepEqual(Object.keys(config.lanes).filter((key) => /^[a-z]$/.test(key)), Object.keys(before.lanes).filter((key) => /^[a-z]$/.test(key)))
    assert.equal(config.agents.reviewer_default, "claude")
  })

  it("keeps the lock guard working: blocks a non-reviewer commit on a locked file, allows others", async () => {
    const repo = await makeRepo()
    assert.equal((await btrain(["init", repo, "--agents", "claude,codex"], repo)).code, 0)
    const preCommit = await fs.readFile(path.join(repo, ".git", "hooks", "pre-commit"), "utf8")
    assert.match(preCommit, /\.btrain\/collab\/HANDOFF\*\.md/)
    await workLaneEndToEnd(repo)

    await fs.appendFile(path.join(repo, "app.js"), "console.log(3)\n")
    await git(repo, ["add", "app.js"])
    const blocked = await git(repo, ["commit", "-qm", "sneak"], { BTRAIN_AGENT: "claude" })
    assert.notEqual(blocked.code, 0)
    assert.match(blocked.stdout + blocked.stderr, /blocked commit/)

    const asReviewer = await git(repo, ["commit", "-qm", "review fix"], { BTRAIN_AGENT: "codex" })
    assert.equal(asReviewer.code, 0, asReviewer.stderr)

    await fs.writeFile(path.join(repo, "other.js"), "x\n")
    await git(repo, ["add", "other.js"])
    const unrelated = await git(repo, ["commit", "-qm", "unrelated"], { BTRAIN_AGENT: "claude" })
    assert.equal(unrelated.code, 0, unrelated.stderr)
  })

  it("keeps the pre-push guard reading local handoffs", async () => {
    const repo = await makeRepo()
    assert.equal((await btrain(["init", repo, "--agents", "claude,codex"], repo)).code, 0)
    const remote = await fs.mkdtemp(path.join(scratch, "remote-"))
    await exec("git", ["init", "-q", "--bare", remote])
    await git(repo, ["remote", "add", "origin", remote])
    await btrain(
      ["handoff", "claim", "--lane", "a", "--task", "t", "--owner", "claude", "--reviewer", "codex", "--files", "app.js"],
      repo,
      { BTRAIN_AGENT: "claude" },
    )
    const push = await git(repo, ["push", "-q", "origin", "main"], { PATH: process.env.PATH })
    assert.notEqual(push.code, 0)
    assert.match(push.stdout + push.stderr, /\.btrain\/collab\/HANDOFF_A\.md: in-progress/)
  })

  it("doctor reports the mode and warns when .btrain state is tracked", async () => {
    const repo = await makeRepo()
    assert.equal((await btrain(["init", repo], repo)).code, 0)
    let doctor = await btrain(["doctor", "--repo", repo], repo)
    assert.match(doctor.stdout, /storage: local/)
    assert.doesNotMatch(doctor.stdout, /git tracks/)
    await git(repo, ["add", "-f", ".btrain/project.toml"])
    doctor = await btrain(["doctor", "--repo", repo], repo)
    assert.match(doctor.stdout, /git tracks 1 file\(s\) under `\.btrain\/`/)
  })
})

describe("tracked mode and existing repos", () => {
  it("--tracked reproduces the committed layout with no storage key", async () => {
    const repo = await makeRepo()
    const result = await btrain(["init", repo, "--tracked", "--agent", "claude", "--agent", "codex"], repo)
    assert.equal(result.code, 0, result.stderr)
    for (const file of ["AGENTS.md", "CLAUDE.md", ".claude/collab/HANDOFF_A.md", ".btrain/project.toml", ".claude/skills/tla-author"]) {
      assert.equal(await exists(path.join(repo, file)), true, `${file} should exist in tracked mode`)
    }
    const config = await readProjectConfig(repo)
    assert.equal(config.storage, undefined)
    assert.equal(config.features, undefined)
    assert.match(await fs.readFile(path.join(repo, ".gitignore"), "utf8"), /!\.btrain\/project\.toml/)
  })

  it("an existing tracked repo stays tracked on plain re-init and refuses --local", async () => {
    const repo = await makeRepo()
    assert.equal((await btrain(["init", repo, "--tracked"], repo)).code, 0)
    const plain = await btrain(["init", repo], repo)
    assert.equal(plain.code, 0, plain.stderr)
    assert.equal((await readProjectConfig(repo)).storage, undefined)
    assert.equal(await exists(path.join(repo, ".btrain", "collab")), false)
    const refused = await btrain(["init", repo, "--local"], repo)
    assert.notEqual(refused.code, 0)
    assert.match(refused.stderr, /already uses tracked btrain storage/)
  })

  it("detects committed legacy btrain files without project.toml and stays tracked", async () => {
    const repo = await makeRepo()
    await fs.mkdir(path.join(repo, ".claude", "collab"), { recursive: true })
    await fs.writeFile(path.join(repo, ".claude", "collab", "HANDOFF_A.md"), "## Current\n\nStatus: idle\n")
    const result = await btrain(["init", repo], repo)
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stdout, /storage: tracked \(existing committed btrain files detected/)
    assert.equal((await readProjectConfig(repo)).storage, undefined)
  })
})

describe("feature toggles", () => {
  it("persists --features / --no-feature choices and skips disabled skills", async () => {
    const repo = await makeRepo()
    const result = await btrain(["init", repo, "--features", "skills,formal,hooks,speckit", "--no-feature", "speckit"], repo)
    assert.equal(result.code, 0, result.stderr)
    const config = await readProjectConfig(repo)
    assert.equal(config.features.formal, true)
    assert.equal(config.features.speckit, false)
    assert.equal(config.features.cgraph, false)
    assert.equal(await exists(path.join(repo, ".btrain", "skills", "tla-author")), true)
    assert.equal(await exists(path.join(repo, ".btrain", "skills", "speckit-plan")), false)
    assert.equal(await exists(path.join(repo, ".btrain", "skills", "pre-handoff")), true)
  })

  it("formal checks are off by default and can be enabled later", async () => {
    const repo = await makeRepo()
    assert.equal((await btrain(["init", repo], repo)).code, 0)
    assert.equal(await exists(path.join(repo, ".btrain", "skills", "tla-run-tlc")), false)
    assert.equal(await exists(path.join(repo, ".btrain", "skills", "speckit-formal")), false)
    const enabled = await btrain(["features", "enable", "formal", "--repo", repo], repo)
    assert.equal(enabled.code, 0, enabled.stderr)
    assert.equal((await readProjectConfig(repo)).features.formal, true)
    assert.equal(await exists(path.join(repo, ".btrain", "skills", "tla-run-tlc")), true)
    assert.equal(await porcelain(repo), "?? .gitignore")
  })

  it("cgraph honors its toggle even when [cgraph] is configured", async () => {
    const repo = await makeRepo()
    assert.equal((await btrain(["init", repo, "--feature", "cgraph"], repo)).code, 0)
    let config = await readProjectConfig(repo)
    assert.equal(config.cgraph.enabled, true)
    let snapshot = await getStartupSnapshot(repo)
    assert.ok(snapshot.cgraph, "cgraph summary should be present while enabled")

    const disabled = await btrain(["features", "disable", "cgraph", "--repo", repo], repo)
    assert.equal(disabled.code, 0, disabled.stderr)
    config = await readProjectConfig(repo)
    assert.equal(config.features.cgraph, false)
    assert.equal(config.cgraph.enabled, true, "the [cgraph] section is left alone")
    snapshot = await getStartupSnapshot(repo)
    assert.equal(snapshot.cgraph, null)
  })

  it("disabled loop, dashboard, and unblocked commands explain how to enable them", async () => {
    const repo = await makeRepo()
    assert.equal((await btrain(["init", repo, "--agents", "claude,codex", "--no-feature", "loop,dashboard"], repo)).code, 0)
    const loop = await btrain(["loop", "--repo", repo, "--dry-run"], repo)
    assert.notEqual(loop.code, 0)
    assert.match(loop.stderr, /btrain features enable loop/)
    const dashboard = await btrain(["dashboard", "start", "--repo", repo], repo)
    assert.notEqual(dashboard.code, 0)
    assert.match(dashboard.stderr, /btrain features enable dashboard/)
    const claim = await btrain(
      ["handoff", "claim", "--lane", "a", "--task", "t", "--owner", "claude", "--reviewer", "codex", "--files", "app.js", "--unblocked-context"],
      repo,
      { BTRAIN_AGENT: "claude" },
    )
    assert.notEqual(claim.code, 0)
    assert.match(claim.stderr, /btrain features enable unblocked/)
  })

  it("features disable hooks removes only btrain-managed hooks", async () => {
    const repo = await makeRepo()
    assert.equal((await btrain(["init", repo], repo)).code, 0)
    assert.equal(await exists(path.join(repo, ".git", "hooks", "pre-commit")), true)
    const result = await btrain(["features", "disable", "hooks", "--repo", repo], repo)
    assert.equal(result.code, 0, result.stderr)
    assert.equal(await exists(path.join(repo, ".git", "hooks", "pre-commit")), false)
    assert.equal(await exists(path.join(repo, ".git", "hooks", "pre-push")), false)
    const listed = await btrain(["features", "list", "--repo", repo], repo)
    assert.match(listed.stdout, /\[ \] hooks/)
  })

  it("rejects unknown feature names", async () => {
    const repo = await makeRepo()
    const result = await btrain(["init", repo, "--features", "skills,warp-drive"], repo)
    assert.notEqual(result.code, 0)
    assert.match(result.stderr, /Unknown feature.*warp-drive/)
    assert.equal(await exists(path.join(repo, ".btrain")), false)
  })

  it("repos without a [features] table keep every feature on", () => {
    for (const id of FEATURE_IDS) {
      assert.equal(isFeatureEnabled({ name: "legacy" }, id), true)
    }
    assert.equal(isFeatureEnabled({ features: { formal: false } }, "formal"), false)
    assert.equal(isFeatureEnabled({ features: { formal: false } }, "cgraph"), true)
  })
})

describe("later commands keep init's choices (review round 1)", () => {
  it("--exclude-local survives re-init, features changes, and agent changes", async () => {
    const repo = await makeRepo()
    assert.equal((await btrain(["init", repo, "--exclude-local", "--agents", "claude,codex"], repo)).code, 0)
    const steps = [
      ["init", repo],
      ["init", repo, "--feature", "formal"],
      ["features", "enable", "zvec", "--repo", repo],
      ["features", "disable", "zvec", "--repo", repo],
      ["agents", "set", "--repo", repo, "--agent", "claude", "--agent", "gemini"],
      ["agents", "add", "--repo", repo, "--agent", "codex"],
    ]
    for (const args of steps) {
      const result = await btrain(args, repo)
      assert.equal(result.code, 0, `${args.join(" ")}: ${result.stderr}`)
      assert.equal(await exists(path.join(repo, ".gitignore")), false, `${args.join(" ")} created .gitignore`)
      assert.equal(await porcelain(repo), "", `${args.join(" ")} dirtied the tree`)
    }
  })

  it("enabling pr_flow on re-init turns [pr_flow] on, and disabling turns it off", async () => {
    const repo = await makeRepo()
    assert.equal((await btrain(["init", repo], repo)).code, 0)
    assert.equal((await btrain(["init", repo, "--feature", "pr_flow"], repo)).code, 0)
    let config = await readProjectConfig(repo)
    assert.equal(config.features.pr_flow, true)
    assert.equal(config.pr_flow.enabled, true)
    assert.equal((await btrain(["features", "disable", "pr_flow", "--repo", repo], repo)).code, 0)
    config = await readProjectConfig(repo)
    assert.equal(config.features.pr_flow, false)
    assert.equal(config.pr_flow.enabled, false)
  })

  it("a legacy tracked repo reports its real cgraph/pr_flow state and can enable cgraph", async () => {
    const repo = await makeRepo()
    assert.equal((await btrain(["init", repo, "--tracked"], repo)).code, 0)
    const listed = await btrain(["features", "list", "--repo", repo, "--format", "json"], repo)
    const map = JSON.parse(listed.stdout).features
    assert.equal(map.pr_flow, false, "tracked template ships [pr_flow] enabled = false")
    assert.equal(map.cgraph, false, "no [cgraph] section")
    assert.equal(map.formal, true)
    assert.equal((await btrain(["init", repo, "--feature", "cgraph"], repo)).code, 0)
    const config = await readProjectConfig(repo)
    assert.equal(config.features.cgraph, true)
    assert.equal(config.cgraph.enabled, true)
    assert.equal(config.features.pr_flow, false, "pr_flow is not silently flipped on")
  })

  it("init --feature/--no-feature hooks installs and removes the managed hooks", async () => {
    const repo = await makeRepo()
    const preCommit = path.join(repo, ".git", "hooks", "pre-commit")
    assert.equal((await btrain(["init", repo, "--no-feature", "hooks"], repo)).code, 0)
    assert.equal(await exists(preCommit), false)
    assert.equal((await btrain(["init", repo, "--feature", "hooks"], repo)).code, 0)
    assert.equal(await exists(preCommit), true)
    assert.equal((await btrain(["init", repo, "--no-feature", "hooks"], repo)).code, 0)
    assert.equal(await exists(preCommit), false)
    const enabled = await btrain(["features", "enable", "hooks", "--repo", repo], repo)
    assert.equal(enabled.code, 0, enabled.stderr)
    assert.equal(await exists(preCommit), true)
  })

  it("local mode rewrites state paths inside copied skills; tracked mode keeps them", async () => {
    const local = await makeRepo("local")
    assert.equal((await btrain(["init", local], local)).code, 0)
    const localSkill = await fs.readFile(path.join(local, ".btrain", "skills", "feedback-triage", "SKILL.md"), "utf8")
    assert.doesNotMatch(localSkill, /\.claude\/collab\//)
    assert.match(localSkill, /\.btrain\/collab\/FEEDBACK_LOG\.md/)

    const tracked = await makeRepo("tracked")
    assert.equal((await btrain(["init", tracked, "--tracked"], tracked)).code, 0)
    const trackedSkill = await fs.readFile(path.join(tracked, ".claude", "skills", "feedback-triage", "SKILL.md"), "utf8")
    assert.match(trackedSkill, /\.claude\/collab\/FEEDBACK_LOG\.md/)
  })
})

describe("init choices parsing", () => {
  it("resolveFeatureMap applies --features, --feature, and --no-feature in order", () => {
    const map = resolveFeatureMap({ features: "skills,hooks", enable: ["tla"], disable: "hooks" })
    assert.equal(map.skills, true)
    assert.equal(map.formal, true)
    assert.equal(map.hooks, false)
    assert.equal(map.dashboard, false)
    assert.deepEqual(resolveFeatureMap({}), getDefaultFeatureMap())
  })

  it("applyFeatureAnswer toggles by number or name and forces with +/-", () => {
    const base = getDefaultFeatureMap()
    const formalIndex = FEATURE_IDS.indexOf("formal") + 1
    assert.equal(applyFeatureAnswer(String(formalIndex), base).formal, true)
    const forced = applyFeatureAnswer("+cgraph -loop hooks", base)
    assert.equal(forced.cgraph, true)
    assert.equal(forced.loop, false)
    assert.equal(forced.hooks, !base.hooks)
    assert.deepEqual(applyFeatureAnswer("", base), base)
    assert.throws(() => applyFeatureAnswer("bogus", base), /Unrecognized/)
  })

  it("runInitQuestions returns features, agents, and reviewer from scripted answers", async () => {
    const answers = ["+formal -dashboard", "", "claude, codex, app-developer", "app-developer"]
    const result = await runInitQuestions({ ask: async () => answers.shift(), write: () => {} })
    assert.equal(result.featureMap.formal, true)
    assert.equal(result.featureMap.dashboard, false)
    assert.deepEqual(result.agents, ["claude", "app-developer", "codex"])
    assert.equal(result.reviewer, "app-developer")
  })

  it("runInitQuestions accepts all defaults on blank answers", async () => {
    const result = await runInitQuestions({ ask: async () => "", write: () => {} })
    assert.deepEqual(result.featureMap, getDefaultFeatureMap())
    assert.deepEqual(result.agents, ["claude", "codex"])
    assert.equal(result.reviewer, "codex")
  })

  it("agent list helpers split, dedupe, and order the reviewer second", () => {
    assert.deepEqual(parseAgentList(["claude,codex"], "Codex,gemini"), ["claude", "codex", "gemini"])
    assert.deepEqual(orderAgentsForReviewer(["codex", "claude"], "codex"), ["claude", "codex"])
    assert.deepEqual(orderAgentsForReviewer(["claude"], ""), ["claude"])
  })

  it("prompts only on an interactive TTY without --yes or CI", () => {
    const tty = { isTTY: true }
    assert.equal(shouldPromptForInit({ stdin: tty, stdout: tty, env: {} }), true)
    assert.equal(shouldPromptForInit({ stdin: tty, stdout: tty, yes: true, env: {} }), false)
    assert.equal(shouldPromptForInit({ stdin: tty, stdout: tty, env: { CI: "true" } }), false)
    assert.equal(shouldPromptForInit({ stdin: {}, stdout: tty, env: {} }), false)
  })

  it("upsertFeaturesTable replaces the table in place and keeps unknown keys", () => {
    const toml = 'name = "x"\n\n[features]\nformal = true\ncustom = 1\n\n[lanes]\nenabled = true\n'
    const next = upsertFeaturesTable(toml, { ...getDefaultFeatureMap(), formal: false })
    assert.match(next, /\[features\]\nhooks = true[\s\S]*formal = false[\s\S]*custom = 1\n\n\[lanes\]/)
    assert.equal(next.match(/\[features\]/g).length, 1)
  })
})

import { withoutLaneScope, laneScopeKeys } from "./helpers/runner-scope.mjs"
import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { fileURLToPath } from "node:url"

const exec = promisify(execFile)
const CLI_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/brain_train/cli.mjs")

async function makeTmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "btrain-reviewer-dispatch-"))
}

async function rmDir(dirPath) {
  await fs.rm(dirPath, { recursive: true, force: true })
}

function dispatchEnv(cwd, extra = {}) {
  return {
    ...withoutLaneScope(),
    BRAIN_TRAIN_HOME: path.join(cwd, ".btrain-test-home"),
    BTRAIN_NO_REVIEW_DISPATCH: "0",
    BTRAIN_AGENT: "owner",
    BRAIN_TRAIN_AGENT: "owner",
    BTRAIN_CLI: CLI_PATH,
    ...extra,
  }
}

async function runBtrain(args, cwd, envOverrides = {}) {
  try {
    const result = await exec("node", [CLI_PATH, ...args], {
      cwd,
      env: dispatchEnv(cwd, envOverrides),
      maxBuffer: 5 * 1024 * 1024,
    })
    return { stdout: result.stdout.trim(), stderr: result.stderr.trim(), code: 0 }
  } catch (error) {
    return {
      stdout: error.stdout?.trim() || "",
      stderr: error.stderr?.trim() || "",
      code:
        typeof error.code === "number"
          ? error.code
          : typeof error.status === "number"
            ? error.status
            : 1,
    }
  }
}

async function writeExecutable(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, content, "utf8")
  await fs.chmod(filePath, 0x1ed)
}

async function setRunnerConfig(tmpDir, mappingLines) {
  const tomlPath = path.join(tmpDir, ".btrain", "project.toml")
  const toml = await fs.readFile(tomlPath, "utf8")
  const updated = toml.replace(
    /\[agents\.runners\][\s\S]*?\n\[reviews\]/,
    `[agents.runners]\n${mappingLines.join("\n")}\n\n[reviews]`,
  )
  await fs.writeFile(tomlPath, updated, "utf8")
}

async function enablePrFlow(tmpDir) {
  const tomlPath = path.join(tmpDir, ".btrain", "project.toml")
  const toml = await fs.readFile(tomlPath, "utf8")
  await fs.writeFile(
    tomlPath,
    toml.replace(/^enabled = false$/m, "enabled = true"),
    "utf8",
  )
}

function fakeClaudeSource() {
  return `#!/usr/bin/env node
const fs = require("node:fs")
const { spawnSync } = require("node:child_process")
const action = process.env.REVIEWER_ACTION || "resolve"
if (process.env.REVIEWER_SPAWN_MARK) {
  fs.writeFileSync(process.env.REVIEWER_SPAWN_MARK, "spawned\\n")
}
if (process.env.REVIEWER_ARGV_PATH) {
  fs.writeFileSync(process.env.REVIEWER_ARGV_PATH, JSON.stringify(process.argv), "utf8")
}
if (action === "fail") {
  process.exit(1)
}
if (action === "hang") {
  process.on("SIGTERM", () => {})
  setInterval(() => {}, 1000)
  return
}
if (action === "hang-tree") {
  // Parent ignores SIGTERM and spawns a descendant that inherits stdout/stderr.
  // Killing only the direct child leaves the descendant holding pipes open so
  // Node's close event never fires unless the whole process group is signaled.
  const { spawn } = require("node:child_process")
  process.on("SIGTERM", () => {})
  spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], {
    stdio: ["ignore", "inherit", "inherit"],
  })
  setInterval(() => {}, 1000)
  return
}
const cli = process.env.BTRAIN_CLI
const lane = process.env.BTRAIN_LANE || "a"
const args = action === "request-changes"
  ? ["handoff", "request-changes", "--lane", lane, "--summary", "Needs a test", "--reason-code", "spec-mismatch", "--actor", "claude"]
  : ["handoff", "resolve", "--lane", lane, "--summary", "Looks good", "--actor", "claude"]
const result = spawnSync(process.execPath, [cli, ...args], {
  cwd: process.cwd(),
  env: process.env,
  encoding: "utf8",
})
if (result.status) {
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  process.exit(result.status)
}
if (process.env.REVIEWER_EXIT_AFTER) {
  process.exit(Number(process.env.REVIEWER_EXIT_AFTER) || 1)
}
`
}

async function setupRepo() {
  const tmpDir = await makeTmpDir()
  await exec("git", ["init", tmpDir])
  await exec("git", ["-C", tmpDir, "config", "user.email", "test@example.com"])
  await exec("git", ["-C", tmpDir, "config", "user.name", "Test Bot"])
  const init = await runBtrain(["init", tmpDir, "--agent", "owner", "--agent", "claude", "--core-only"], tmpDir)
  assert.equal(init.code, 0, init.stderr)
  await fs.mkdir(path.join(tmpDir, "src"), { recursive: true })
  await fs.writeFile(path.join(tmpDir, "src", "feature.ts"), "export const feature = true\\n", "utf8")
  const claudeBin = path.join(tmpDir, "bin", "claude")
  await writeExecutable(claudeBin, fakeClaudeSource())
  await setRunnerConfig(tmpDir, [`"owner" = "notify"`, `"claude" = "${claudeBin} -p"`])
  const claim = await runBtrain(
    [
      "handoff", "claim", "--repo", tmpDir, "--lane", "a",
      "--task", "Review dispatch",
      "--owner", "owner",
      "--reviewer", "claude",
      "--files", "src/feature.ts",
    ],
    tmpDir,
    { BTRAIN_AGENT: "owner" },
  )
  assert.equal(claim.code, 0, claim.stderr)
  return { tmpDir, claudeBin }
}

function needsReviewArgs(tmpDir) {
  return [
    "handoff", "update", "--repo", tmpDir, "--lane", "a", "--status", "needs-review",
    "--actor", "owner",
    "--base", "feat/review-dispatch",
    "--no-diff",
    "--preflight",
    "--changed", "src/feature.ts - implement the change",
    "--verification", "node --test test/reviewer-dispatch.test.mjs",
    "--gap", "Did not rerun a browser smoke test",
    "--why", "The lane is ready for peer review.",
    "--review-ask", "Check the targeted behavior.",
    "--timeout", "5",
    "--poll-interval", "0.05",
  ]
}

async function readLane(tmpDir) {
  return fs.readFile(path.join(tmpDir, ".claude", "collab", "HANDOFF_A.md"), "utf8")
}

describe("needs-review reviewer dispatch", () => {
  it("rejects invalid dispatch timeout before writing needs-review", async () => {
    const { tmpDir } = await setupRepo()
    try {
      const args = needsReviewArgs(tmpDir)
      const timeoutIndex = args.indexOf("--timeout")
      args[timeoutIndex + 1] = "0"
      const result = await runBtrain(args, tmpDir)
      assert.notEqual(result.code, 0)
      assert.match(`${result.stdout}\n${result.stderr}`, /--timeout must be a positive number/)
      const content = await readLane(tmpDir)
      assert.match(content, /Status: in-progress/)
      assert.doesNotMatch(content, /Status: needs-review/)
    } finally {
      await rmDir(tmpDir)
    }
  })

  it("spawns a claude -p reviewer and resolves the lane on approval", async () => {
    const { tmpDir } = await setupRepo()
    try {
      const spawnMark = path.join(tmpDir, "spawned.txt")
      const argvPath = path.join(tmpDir, "argv.json")
      const result = await runBtrain(needsReviewArgs(tmpDir), tmpDir, {
        REVIEWER_SPAWN_MARK: spawnMark,
        REVIEWER_ARGV_PATH: argvPath,
        REVIEWER_ACTION: "resolve",
      })
      assert.equal(result.code, 0, `${result.stdout}\\n${result.stderr}`)
      assert.match(result.stdout, /dispatch claude/)
      assert.match(result.stdout, /status: resolved/)
      const spawned = await fs.readFile(spawnMark, "utf8")
      assert.match(spawned, /spawned/)
      const argv = JSON.parse(await fs.readFile(argvPath, "utf8"))
      assert.ok(argv.includes("-p"), `expected -p in ${JSON.stringify(argv)}`)
      assert.ok(argv.some((token) => token === "bth" || token.startsWith("bth ")), `expected bth prompt in ${JSON.stringify(argv)}`)
      assert.ok(argv.some((token) => String(token).includes("--lane a") || token === "--lane"), `expected lane in prompt: ${JSON.stringify(argv)}`)
      const content = await readLane(tmpDir)
      assert.match(content, /Status: resolved/)
    } finally {
      await rmDir(tmpDir)
    }
  })

  it("applies request-changes onto the lane instead of approving", async () => {
    const { tmpDir } = await setupRepo()
    try {
      const spawnMark = path.join(tmpDir, "spawned.txt")
      const result = await runBtrain(needsReviewArgs(tmpDir), tmpDir, {
        REVIEWER_SPAWN_MARK: spawnMark,
        REVIEWER_ACTION: "request-changes",
      })
      assert.equal(result.code, 0, `${result.stdout}\\n${result.stderr}`)
      assert.match(result.stdout, /dispatch claude/)
      assert.match(result.stdout, /status: changes-requested/)
      const content = await readLane(tmpDir)
      assert.match(content, /Status: changes-requested/)
      assert.doesNotMatch(content, /Status: resolved/)
    } finally {
      await rmDir(tmpDir)
    }
  })

  it("keeps local approval on PR-flow lanes at ready-for-pr", async () => {
    const { tmpDir } = await setupRepo()
    try {
      await enablePrFlow(tmpDir)
      const result = await runBtrain(needsReviewArgs(tmpDir), tmpDir, {
        REVIEWER_ACTION: "resolve",
      })
      assert.equal(result.code, 0, `${result.stdout}\\n${result.stderr}`)
      assert.match(result.stdout, /status: ready-for-pr/)
      const content = await readLane(tmpDir)
      assert.match(content, /Status: ready-for-pr/)
      assert.doesNotMatch(content, /Status: resolved/)
    } finally {
      await rmDir(tmpDir)
    }
  })

  it("does not spawn notify reviewers", async () => {
    const { tmpDir, claudeBin } = await setupRepo()
    try {
      await setRunnerConfig(tmpDir, [`"owner" = "notify"`, `"claude" = "notify"`])
      const spawnMark = path.join(tmpDir, "spawned.txt")
      const result = await runBtrain(needsReviewArgs(tmpDir), tmpDir, {
        REVIEWER_SPAWN_MARK: spawnMark,
      })
      assert.equal(result.code, 0, `${result.stdout}\\n${result.stderr}`)
      assert.match(result.stdout, /reviewer dispatch skipped: notify runner for claude is not spawned/)
      assert.match(result.stdout, /status: needs-review/)
      assert.equal(await fs.access(spawnMark).then(() => true, () => false), false)
      assert.equal(await fs.access(claudeBin).then(() => true, () => false), true)
      const content = await readLane(tmpDir)
      assert.match(content, /Status: needs-review/)
    } finally {
      await rmDir(tmpDir)
    }
  })

  it("accepts a completed review even if the reviewer CLI then exits nonzero", async () => {
    const { tmpDir } = await setupRepo()
    try {
      const result = await runBtrain(needsReviewArgs(tmpDir), tmpDir, {
        REVIEWER_ACTION: "resolve",
        REVIEWER_EXIT_AFTER: "1",
      })
      assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`)
      assert.match(result.stdout, /status: resolved/)
      const content = await readLane(tmpDir)
      assert.match(content, /Status: resolved/)
    } finally {
      await rmDir(tmpDir)
    }
  })

  it("treats a failing reviewer runner as infrastructure failure, not approval", async () => {
    const { tmpDir } = await setupRepo()
    try {
      const spawnMark = path.join(tmpDir, "spawned.txt")
      const result = await runBtrain(needsReviewArgs(tmpDir), tmpDir, {
        REVIEWER_SPAWN_MARK: spawnMark,
        REVIEWER_ACTION: "fail",
      })
      assert.notEqual(result.code, 0)
      assert.match(`${result.stdout}\\n${result.stderr}`, /Reviewer dispatch failed/)
      assert.match(`${result.stdout}\\n${result.stderr}`, /not approved|needs-review/)
      const spawned = await fs.readFile(spawnMark, "utf8")
      assert.match(spawned, /spawned/)
      const content = await readLane(tmpDir)
      assert.match(content, /Status: needs-review/)
      assert.doesNotMatch(content, /Status: resolved/)
      assert.doesNotMatch(content, /Status: ready-for-pr/)
    } finally {
      await rmDir(tmpDir)
    }
  })

  it("treats a timed-out reviewer as infrastructure failure, not approval", async () => {
    const { tmpDir } = await setupRepo()
    try {
      const args = needsReviewArgs(tmpDir)
      const timeoutIndex = args.indexOf("--timeout")
      args[timeoutIndex + 1] = "0.4"
      const result = await runBtrain(args, tmpDir, {
        REVIEWER_ACTION: "hang",
      })
      assert.notEqual(result.code, 0)
      assert.match(`${result.stdout}\\n${result.stderr}`, /Reviewer dispatch timed-out|Timed out/)
      const content = await readLane(tmpDir)
      assert.match(content, /Status: needs-review/)
      assert.doesNotMatch(content, /Status: resolved/)
    } finally {
      await rmDir(tmpDir)
    }
  })

  it("times out even when a reviewer descendant inherits stdout/stderr", async () => {
    const { tmpDir } = await setupRepo()
    try {
      const args = needsReviewArgs(tmpDir)
      const timeoutIndex = args.indexOf("--timeout")
      args[timeoutIndex + 1] = "0.4"
      const started = Date.now()
      const result = await Promise.race([
        runBtrain(args, tmpDir, { REVIEWER_ACTION: "hang-tree" }),
        new Promise((resolve) =>
          setTimeout(
            () => resolve({ code: -1, stdout: "", stderr: "TEST_WALL_TIMEOUT" }),
            8000,
          ),
        ),
      ])
      const elapsedMs = Date.now() - started
      assert.notEqual(result.stderr, "TEST_WALL_TIMEOUT", "dispatch hung past wall timeout; process tree was not reaped")
      assert.notEqual(result.code, 0)
      assert.match(`${result.stdout}\n${result.stderr}`, /Reviewer dispatch timed-out|Timed out/)
      assert.ok(elapsedMs < 7000, `expected timeout path to finish promptly, took ${elapsedMs}ms`)
      const content = await readLane(tmpDir)
      assert.match(content, /Status: needs-review/)
      assert.doesNotMatch(content, /Status: resolved/)
    } finally {
      await rmDir(tmpDir)
    }
  })

  it("returns the newer lane state when status leaves needs-review before dispatch", async () => {
    const { tmpDir } = await setupRepo()
    const handoffPath = path.join(tmpDir, ".claude", "collab", "HANDOFF_A.md")
    const spawnMark = path.join(tmpDir, "spawned.txt")
    let poller
    try {
      poller = execFile(
        process.execPath,
        [
          "-e",
          `const fs = require("node:fs");
const p = process.argv[1];
const deadline = Date.now() + 20000;
while (Date.now() < deadline) {
  try {
    let text = fs.readFileSync(p, "utf8");
    if (text.includes("Status: needs-review")) {
      text = text.replace("Status: needs-review", "Status: ready-for-pr");
      fs.writeFileSync(p, text);
      process.exit(0);
    }
  } catch {}
}
process.exit(1);`,
          handoffPath,
        ],
        () => {},
      )

      const args = needsReviewArgs(tmpDir)
      const timeoutIndex = args.indexOf("--timeout")
      args[timeoutIndex + 1] = "2"
      const started = Date.now()
      const result = await runBtrain(args, tmpDir, {
        REVIEWER_SPAWN_MARK: spawnMark,
        REVIEWER_ACTION: "resolve",
      })
      const elapsedMs = Date.now() - started
      assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`)
      assert.match(result.stdout, /status: ready-for-pr|lane already ready-for-pr/)
      assert.doesNotMatch(result.stdout, /status: needs-review/)
      // Must not fall into owner notify-wait for the full timeout budget.
      assert.ok(elapsedMs < 1800, `expected early return after status change, took ${elapsedMs}ms`)
      const content = await readLane(tmpDir)
      assert.match(content, /Status: ready-for-pr/)
      assert.doesNotMatch(content, /Status: needs-review/)
      assert.doesNotMatch(content, /Status: resolved/)
    } finally {
      if (poller?.pid) {
        try { process.kill(poller.pid, "SIGKILL") } catch {}
      }
      await rmDir(tmpDir)
    }
  })

  it("does not nested-dispatch when already inside btrain loop", async () => {
    const { tmpDir } = await setupRepo()
    try {
      const spawnMark = path.join(tmpDir, "spawned.txt")
      const result = await runBtrain(needsReviewArgs(tmpDir), tmpDir, {
        REVIEWER_SPAWN_MARK: spawnMark,
        BTRAIN_LOOP_ACTIVE: "1",
      })
      assert.equal(result.code, 0, `${result.stdout}\\n${result.stderr}`)
      assert.match(result.stdout, /status: needs-review/)
      assert.doesNotMatch(result.stdout, /dispatch claude/)
      assert.equal(await fs.access(spawnMark).then(() => true, () => false), false)
    } finally {
      await rmDir(tmpDir)
    }
  })
})

let sourceOfCore = ""

async function readRunnerEnvBody() {
  const corePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/brain_train/core.mjs")
  sourceOfCore = await fs.readFile(corePath, "utf8")
  const start = sourceOfCore.indexOf("function buildLoopRunnerEnv(")
  assert.ok(start !== -1, "buildLoopRunnerEnv must still exist for these guards to mean anything")
  const end = sourceOfCore.indexOf("\n}\n", start)
  // Without this, `indexOf` returning -1 makes `slice(start, -1)` read to EOF.
  // Review confirmed that over-read yields the same six names and zero
  // unresolvable keys -- a silent pass that scans 368 KB and reports success.
  assert.ok(end !== -1, "could not find the end of buildLoopRunnerEnv; the guard would read to EOF")
  return { body: sourceOfCore.slice(start, end), start, end }
}

describe("lane-scope stripping keeps pace with the runner env", () => {
  // Lane d. The reviewer-dispatch suite failed for six consecutive codex review
  // rounds and passed in every direct run. Cause: `buildLoopRunnerEnv` injects
  // BTRAIN_LOOP_ACTIVE=1 into a spawned runner, a dispatched reviewer runs the
  // suite as a child of that runner, and `withoutLaneScope` did not strip it.
  // `dispatchNeedsReviewReviewer` then took its nested-dispatch guard and
  // returned "skipped", so every test asserting a spawn failed while the two
  // asserting no spawn passed — and the handoff update still exited 0, which
  // made it look like a product bug instead of a leaked variable.

  it("strips BTRAIN_LOOP_ACTIVE so a dispatched run still exercises dispatch", () => {
    const clean = withoutLaneScope({ ...process.env, BTRAIN_LOOP_ACTIVE: "1" })
    assert.equal(clean.BTRAIN_LOOP_ACTIVE, undefined)
  })

  it("strips every environment variable buildLoopRunnerEnv injects", async () => {
    // This guard does not parse core.mjs. It recognises the four spellings
    // buildLoopRunnerEnv currently uses, and — see the next test — fails loudly
    // if the function starts using one it does not recognise. That is the
    // honest description: "derived from the source" would overstate it, and an
    // earlier version of this comment did. The real cure is the follow-up this
    // PR names: export one shared constant from core.mjs and delete the
    // derivation entirely.
    const { body } = await readRunnerEnvBody()

    const ENV_NAME = /^(?:BTRAIN|BRAIN_TRAIN)_[A-Z0-9_]+$/
    const injected = new Set()

    for (const m of body.matchAll(/(?:^\s*|env\.)([A-Z][A-Z0-9_]*)\s*[:=][^=]/gm)) {
      if (ENV_NAME.test(m[1])) injected.add(m[1])
    }
    for (const m of body.matchAll(/\[([A-Za-z_$][A-Za-z0-9_$]*)\]\s*:/g)) {
      // Anchored to a declaration line so a shadowed const cannot resolve to
      // the wrong one, and escaped because a name may contain `$`.
      const escaped = m[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      const decl = body.match(new RegExp(`^\\s*const ${escaped} = ["']([A-Z][A-Z0-9_]*)["']`, "m"))
        || sourceOfCore.match(new RegExp(`^const ${escaped} = ["']([A-Z][A-Z0-9_]*)["']`, "m"))
      // A const key that resolves to something outside the lane-scope
      // namespace is a legitimate edit (NODE_NO_WARNINGS, say) and must not
      // fail this test. Only an unresolvable name is a problem.
      if (decl && ENV_NAME.test(decl[1])) injected.add(decl[1])
    }
    for (const m of body.matchAll(/delete\s+env\.([A-Z][A-Z0-9_]*)/g)) {
      if (ENV_NAME.test(m[1])) injected.add(m[1])
    }

    for (const expected of [
      "BTRAIN_AGENT", "BRAIN_TRAIN_AGENT", "BTRAIN_LOOP_ACTIVE",
      "BTRAIN_LANE", "BTRAIN_LANE_LOCKED", "BTRAIN_REPO",
    ]) {
      assert.ok(injected.has(expected), `${expected} must be derivable from buildLoopRunnerEnv; found ${[...injected].sort()}`)
    }

    const stripped = withoutLaneScope({
      ...Object.fromEntries([...injected].map((k) => [k, "1"])),
    })
    assert.deepEqual(
      [...injected].filter((k) => stripped[k] !== undefined),
      [],
      "withoutLaneScope must strip every variable buildLoopRunnerEnv injects",
    )
  })

  it("fails loudly if buildLoopRunnerEnv uses a spelling the guard cannot read", async () => {
    // The fourth hole, found by review after the first three were closed. The
    // guard reads four syntactic forms. Five ordinary alternatives — a spread,
    // a template-literal key, a concatenated key, Object.assign, and
    // `env["X"] = v` — each injected a variable that was never stripped and
    // still passed the suite. A regex cannot be made to cover every spelling,
    // so instead of pretending otherwise, refuse to run against a body that
    // uses one. A loud failure on an unrecognised spelling is the property
    // that matters; a silent miss is the failure this whole PR is about.
    const { body } = await readRunnerEnvBody()

    const unreadable = [
      // `...process.env` is the base the function builds on and is expected.
      // Any other spread could carry variables this guard never sees.
      [/\.\.\.(?!process\.env\b)[A-Za-z_$]/, "a spread of something other than process.env"],
      [/Object\.assign/, "Object.assign"],
      [/env\s*\[/, "bracket assignment (`env[\"X\"] = v`)"],
      [/\[\s*`/, "a template-literal computed key"],
      [/\[\s*["'][^"']*["']\s*\+/, "a concatenated computed key"],
    ]
    const found = unreadable.filter(([re]) => re.test(body)).map(([, label]) => label)
    assert.deepEqual(
      found,
      [],
      `buildLoopRunnerEnv now uses ${found.join(", ")}, which this guard cannot read. `
      + "Either teach the guard that spelling, or export the variable list from core.mjs "
      + "and have runner-scope.mjs import it instead of deriving it.",
    )
  })

  it("keeps the npm scripts in step with the helper", async () => {
    // npm test unsets these with `env -u`; a var missing there fails the same
    // way for anyone running the full suite under a dispatch.
    const pkgPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../package.json")
    const pkg = JSON.parse(await fs.readFile(pkgPath, "utf8"))
    for (const name of ["test", "test:e2e", "test:formal"]) {
      const script = pkg.scripts[name]
      assert.ok(script, `${name} script must exist`)
      // Derived from the helper, not pinned to one variable: adding a seventh
      // to both buildLoopRunnerEnv and LANE_SCOPE_KEYS while forgetting
      // package.json used to pass every guard while npm test broke under a
      // dispatch exactly as before.
      for (const key of laneScopeKeys()) {
        assert.match(
          script,
          new RegExp(`-u ${key}\\b`),
          `${name} must unset ${key} or the full suite fails under a dispatch`,
        )
      }
    }
  })
})

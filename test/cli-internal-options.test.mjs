// spec 015 transition gate inputs are internal to btrain. patchHandoff and
// resolveHandoff read the gate's classification inputs from the same options
// object as the CLI flags: `btrain pr poll --apply` passes transitionEvent
// "pr-poll" and viaPrOutcome, and `btrain pr create` passes transitionEvent
// "pr-create" and transitionCompatibility. parseOptions accepted any
// `--key value`, and `btrain handoff` spread the whole bag into core. A caller
// could therefore pick the row that gates its own change (system rows such as
// 10 PrClear and L16 accept any actor), skip row 7's owner check, or record
// the pr-poll provenance that row 12 later trusts. These tests run the real
// CLI.
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"

import { applyPrStatusToHandoff } from "../src/brain_train/pr-flow.mjs"
import { withoutLaneScope } from "./helpers/runner-scope.mjs"

const exec = promisify(execFile)
const CLI = path.resolve("src/brain_train/cli.mjs")
const INTERNAL_OPTIONS_MODULE = "../src/brain_train/internal_options.mjs"

const PROJECT_TOML = `[project]
name = "cli-internal-options"

[agents]
active = ["alpha", "beta", "gamma"]

[lanes]
enabled = true
ids = ["x"]

[lanes.x]
handoff_path = ".claude/collab/HANDOFF_X.md"

[pr_flow]
enabled = true
base = "main"
required_bots = ["codex"]
`

// A lane repo with pr_flow on: alpha owns lane x, beta reviews it, and gamma
// is a configured agent outside the lane.
async function withLaneRepo(fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "btrain-cli-internal-"))
  const repo = path.join(root, "repo")
  const home = path.join(root, "home")
  await fs.mkdir(path.join(repo, ".btrain"), { recursive: true })
  await fs.mkdir(path.join(repo, ".claude", "collab"), { recursive: true })
  await fs.writeFile(path.join(repo, ".btrain", "project.toml"), PROJECT_TOML)

  const btrain = async (agent, ...args) => {
    try {
      const { stdout, stderr } = await exec("node", [CLI, ...args, "--repo", repo], {
        env: { ...withoutLaneScope(), BRAIN_TRAIN_HOME: home, BTRAIN_AGENT: agent, BTRAIN_DASHBOARD_DISABLED: "1" },
        // Only a hang should hit this: a loaded machine slows every CLI run.
        timeout: 120_000,
      })
      return { code: 0, stdout, stderr }
    } catch (error) {
      return { code: typeof error.code === "number" ? error.code : 1, stdout: error.stdout || "", stderr: error.stderr || "" }
    }
  }

  try {
    await fn({ repo, home, btrain })
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}

async function ok(run) {
  const result = await run
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`)
  return result
}

// Drives lane x through the real CLI: claim, then (for the PR-flow states)
// row 2 into needs-review, the reviewer's row 4 approval, and row 7 linking
// PR #12.
async function laneAt(btrain, status) {
  await ok(btrain("alpha", "handoff", "claim", "--lane", "x", "--task", "gate inputs", "--owner", "alpha", "--reviewer", "beta", "--files", "src/a/"))
  if (status === "in-progress") return
  await ok(btrain(
    "alpha", "handoff", "update", "--lane", "x", "--status", "needs-review", "--no-diff", "--no-dispatch",
    "--base", "main", "--preflight", "checked the locked files", "--changed", "src/a/ fixture",
    "--verification", "fixture only", "--gap", "no gaps", "--why", "fixture", "--review-ask", "fixture",
  ))
  await ok(btrain("beta", "handoff", "resolve", "--lane", "x", "--summary", "approved"))
  if (status === "ready-for-pr") return
  await ok(btrain("alpha", "handoff", "update", "--lane", "x", "--status", "pr-review", "--pr", "12"))
}

// Every file under the repo, so a rejected command provably changed nothing:
// not the lane handoff, the lock registry, or the workflow event log.
async function snapshot(repo) {
  const files = {}
  async function walk(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) await walk(fullPath)
      else files[path.relative(repo, fullPath)] = await fs.readFile(fullPath, "utf8")
    }
  }
  await walk(repo)
  return files
}

async function laneEvents(repo) {
  const content = await fs.readFile(path.join(repo, ".btrain", "events", "lane-x.jsonl"), "utf8")
  return content.split("\n").filter(Boolean).map((line) => JSON.parse(line))
}

async function lastUpdate(repo) {
  return (await laneEvents(repo)).filter((event) => event.type === "update").at(-1)
}

async function assertRejected(repo, run, flag) {
  const before = await snapshot(repo)
  const result = await run
  assert.notEqual(result.code, 0, `the CLI accepted ${flag}:\n${result.stdout}`)
  assert.match(result.stderr, /internal to btrain/)
  assert.ok(result.stderr.includes(`\`${flag}\``), result.stderr)
  assert.deepEqual(await snapshot(repo), before, `a rejected ${flag} still changed the repo`)
}

describe("btrain CLI rejects internal-only transition gate inputs", () => {
  it("rejects a forged pr-poll label, so an owner cannot take row 10 (PrClear)", async () => {
    await withLaneRepo(async ({ repo, btrain }) => {
      await laneAt(btrain, "pr-review")

      await assertRejected(repo, btrain("alpha", "handoff", "update", "--lane", "x", "--transitionEvent", "pr-poll", "--status", "ready-to-merge"), "--transitionEvent")

      // The same move without the label is what btrain records: a legacy
      // status update, accepted with the L4 advisory until enforcement.
      await ok(btrain("alpha", "handoff", "update", "--lane", "x", "--status", "ready-to-merge"))
      const event = await lastUpdate(repo)
      assert.equal(event.before.status, "pr-review")
      assert.equal(event.after.status, "ready-to-merge")
      assert.equal(event.details.transitionEvent, "handoff update --status")
      assert.equal(event.details["transition-advisory"], "L4")
    })
  })

  it("rejects a forged pr-poll label that would record PR-flow provenance for row 12", async () => {
    await withLaneRepo(async ({ repo, btrain }) => {
      await laneAt(btrain, "pr-review")

      await assertRejected(
        repo,
        btrain("alpha", "handoff", "update", "--lane", "x", "--status", "changes-requested", "--reason-code", "pr-review-feedback", "--transitionEvent", "pr-poll"),
        "--transitionEvent",
      )

      await ok(btrain("alpha", "handoff", "update", "--lane", "x", "--status", "changes-requested", "--reason-code", "pr-review-feedback"))
      let event = await lastUpdate(repo)
      assert.equal(event.after.status, "changes-requested")
      assert.equal(event.details.transitionEvent, "handoff update --status")
      assert.equal(event.details["transition-advisory"], "L4")

      // Only a real pr-poll entry makes this changes-requested PR-flow
      // feedback, so the owner's return to pr-review misses row 12's guard.
      await ok(btrain("alpha", "handoff", "update", "--lane", "x", "--status", "pr-review"))
      event = await lastUpdate(repo)
      assert.equal(event.after.status, "pr-review")
      assert.equal(event.details.transitionEvent, "handoff update --status")
      assert.equal(event.details["transition-advisory"], "L4")
    })
  })

  for (const { name, agent, label } of [
    { name: "a metadata label hiding the reviewer's rescope (row 16)", agent: "beta", label: "handoff update --metadata" },
    { name: "a system label letting a non-lane agent rescope (L16)", agent: "gamma", label: "watchdog-lock-release" },
  ]) {
    it(`rejects ${name}`, async () => {
      await withLaneRepo(async ({ repo, btrain }) => {
        await laneAt(btrain, "in-progress")

        await assertRejected(repo, btrain(agent, "handoff", "update", "--lane", "x", "--files", "src/b/", "--transitionEvent", label), "--transitionEvent")

        await ok(btrain(agent, "handoff", "update", "--lane", "x", "--files", "src/b/"))
        const event = await lastUpdate(repo)
        assert.deepEqual(event.after.lockedFiles, ["src/b/"])
        assert.equal(event.details.transitionEvent, "handoff update --files")
        assert.equal(event.details["transition-advisory"], "L6")
      })
    })
  }

  it("rejects --transitionCompatibility, so row 7 keeps its owner check", async () => {
    await withLaneRepo(async ({ repo, btrain }) => {
      await laneAt(btrain, "ready-for-pr")

      await assertRejected(repo, btrain("beta", "handoff", "update", "--lane", "x", "--status", "pr-review", "--pr", "12", "--transitionCompatibility"), "--transitionCompatibility")

      await ok(btrain("beta", "handoff", "update", "--lane", "x", "--status", "pr-review", "--pr", "12"))
      const event = await lastUpdate(repo)
      assert.equal(event.after.status, "pr-review")
      assert.equal(event.details.transitionEvent, "handoff update --status")
      assert.equal(event.details["transition-advisory"], "L4")
    })
  })

  it("rejects --viaPrOutcome on handoff resolve instead of silently dropping it", async () => {
    await withLaneRepo(async ({ repo, btrain }) => {
      await laneAt(btrain, "pr-review")
      await assertRejected(repo, btrain("alpha", "handoff", "resolve", "--lane", "x", "--viaPrOutcome", "--summary", "merged"), "--viaPrOutcome")
      await assertRejected(repo, btrain("alpha", "handoff", "resolve", "--lane", "x", "--final", "--viaPrOutcome", "--summary", "merged"), "--viaPrOutcome")
    })
  })

  it("rejects them on every handoff subcommand, in any spelling, before reading lane state", async () => {
    await withLaneRepo(async ({ repo, btrain }) => {
      await laneAt(btrain, "in-progress")
      const subcommands = [
        ["handoff"],
        ["handoff", "show-next", "--lane", "x"],
        ["handoff", "wait", "--lane", "x", "--timeout", "1"],
        ["handoff", "pull-pr", "--lane", "x"],
        ["handoff", "claim", "--lane", "x", "--task", "t", "--owner", "gamma", "--files", "src/z/"],
        ["handoff", "update", "--lane", "x", "--next", "n"],
        ["handoff", "request-changes", "--lane", "x", "--summary", "s", "--reason-code", "spec-mismatch"],
        ["handoff", "resolve", "--lane", "x", "--summary", "s"],
      ]
      const forged = [
        ["--transitionEvent", "pr-poll"],
        ["--transitionCompatibility"],
        ["--viaPrOutcome"],
        ["--onEvent", "x"],
      ]
      for (const [index, args] of subcommands.entries()) {
        const option = forged[index % forged.length]
        await assertRejected(repo, btrain("alpha", ...args, ...option), option[0])
      }
      for (const option of [
        ["--transition-event", "pr-poll"],
        ["--transition_event", "pr-poll"],
        ["--TransitionEvent", "pr-poll"],
        ["--via-pr-outcome"],
        ["--TRANSITIONCOMPATIBILITY"],
        ["--on-event", "x"],
      ]) {
        await assertRejected(repo, btrain("alpha", "handoff", "update", "--lane", "x", "--next", "n", ...option), option[0])
      }
    })
  })

  it("keeps btrain's own pr-poll classification: a real PR outcome still takes row 10", async () => {
    await withLaneRepo(async ({ repo, home, btrain }) => {
      await laneAt(btrain, "pr-review")
      const previous = { home: process.env.BRAIN_TRAIN_HOME, agent: process.env.BTRAIN_AGENT }
      process.env.BRAIN_TRAIN_HOME = home
      process.env.BTRAIN_AGENT = "alpha"
      try {
        await applyPrStatusToHandoff(repo, { lane: "x" }, {
          overall: "ready-to-merge",
          bots: [{ id: "codex", state: "clear" }],
          pr: { number: 12 },
        })
      } finally {
        for (const [key, value] of [["BRAIN_TRAIN_HOME", previous.home], ["BTRAIN_AGENT", previous.agent]]) {
          if (value === undefined) delete process.env[key]
          else process.env[key] = value
        }
      }
      const event = await lastUpdate(repo)
      assert.equal(event.after.status, "ready-to-merge")
      assert.equal(event.details.transitionEvent, "pr-poll")
      assert.equal(event.details["transition-advisory"], undefined)
    })
  })
})

describe("internal-only option registry", () => {
  it("matches each internal option in any spelling and leaves CLI flags alone", async () => {
    const { INTERNAL_ONLY_OPTIONS, findInternalOnlyOptions } = await import(INTERNAL_OPTIONS_MODULE)
    assert.deepEqual(Object.keys(INTERNAL_ONLY_OPTIONS).sort(), ["onEvent", "transitionCompatibility", "transitionEvent", "viaPrOutcome"])

    const found = findInternalOnlyOptions({
      _: ["transitionEvent"],
      lane: "x",
      status: "pr-review",
      "no-diff": true,
      "reason-code": "spec-mismatch",
      "review-ask": "a",
      "transition-event": "pr-poll",
      TRANSITION_COMPATIBILITY: true,
      viaproutcome: true,
      onEvent: "x",
    })
    assert.deepEqual(found.map(({ flag, key }) => [flag, key]), [
      ["transition-event", "transitionEvent"],
      ["TRANSITION_COMPATIBILITY", "transitionCompatibility"],
      ["viaproutcome", "viaPrOutcome"],
      ["onEvent", "onEvent"],
    ])
    assert.deepEqual(findInternalOnlyOptions({ _: [], lane: "x", final: true, pr: "12" }), [])
  })

  it("covers every option that btrain's own callers pass to the handoff functions without a CLI flag", async () => {
    const { INTERNAL_ONLY_OPTIONS } = await import(INTERNAL_OPTIONS_MODULE)
    const documented = new Set(
      [...(await exec("node", [CLI, "help"])).stdout.matchAll(/--([a-z][a-z0-9-]*)/g)].map((match) => match[1]),
    )
    const sources = await listSourceFiles(path.resolve("src/brain_train"))
    const unregistered = []
    const passed = new Set()
    for (const file of sources) {
      // The CLI's own calls spread parseOptions output; parseOptions guards those.
      if (file.endsWith(`${path.sep}cli.mjs`)) continue
      const source = await fs.readFile(file, "utf8")
      for (const call of findHandoffCalls(source)) {
        const where = `${path.relative(process.cwd(), file)}:${call.line} ${call.name}`
        if (!call.keys) {
          unregistered.push(`${where}: options are not an inline object literal`)
          continue
        }
        for (const key of call.keys) {
          passed.add(key)
          if (documented.has(key) || Object.hasOwn(INTERNAL_ONLY_OPTIONS, key)) continue
          unregistered.push(`${where}: ${key}`)
        }
      }
    }
    assert.deepEqual(unregistered, [], "register these in src/brain_train/internal_options.mjs, or document them as CLI flags")
    for (const key of ["transitionEvent", "transitionCompatibility", "viaPrOutcome"]) {
      assert.ok(passed.has(key), `expected an internal caller to pass ${key}; the scan found ${[...passed].join(", ")}`)
    }

    // Each registered option is still read by the gate or its callers.
    const gateSources = (await Promise.all(
      ["core.mjs", "transitions.mjs"].map((name) => fs.readFile(path.resolve("src/brain_train", name), "utf8")),
    )).join("\n")
    for (const key of Object.keys(INTERNAL_ONLY_OPTIONS)) {
      assert.match(gateSources, new RegExp(`options\\??\\.${key}\\b`), `${key} is registered but nothing reads it`)
    }
  })
})

async function listSourceFiles(dir) {
  const files = []
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) files.push(...await listSourceFiles(fullPath))
    else if (entry.name.endsWith(".mjs")) files.push(fullPath)
  }
  return files
}

// Calls to the four handoff functions and the top-level keys of their options
// literal (`keys` is null when the options are not an inline literal).
function findHandoffCalls(source) {
  const calls = []
  const pattern = /\b(claimHandoff|patchHandoff|requestChangesHandoff|resolveHandoff)\(/g
  for (const match of source.matchAll(pattern)) {
    if (/function\s+$/.test(source.slice(0, match.index))) continue
    const line = source.slice(0, match.index).split("\n").length
    const afterRepo = source.slice(match.index + match[0].length).match(/^\s*[\w.]+\s*,\s*/)
    const open = afterRepo ? match.index + match[0].length + afterRepo[0].length : -1
    calls.push({ name: match[1], line, keys: open >= 0 && source[open] === "{" ? topLevelKeys(source, open) : null })
  }
  return calls
}

// A small scanner for one object literal: it skips strings, template
// expressions, comments, and nested brackets, and reports spreads and
// computed keys as `...` and `[computed]` so the registry check fails closed.
function topLevelKeys(source, open) {
  const keys = []
  let atKey = true
  for (let index = open + 1; index < source.length; index += 1) {
    const char = source[index]
    if (char === "}") return keys
    if (/\s/.test(char)) continue
    if (source.startsWith("//", index)) { index = source.indexOf("\n", index); continue }
    if (source.startsWith("/*", index)) { index = source.indexOf("*/", index) + 1; continue }
    if (char === ",") { atKey = true; continue }
    if (char === '"' || char === "'" || char === "`") {
      const end = skipString(source, index)
      if (atKey) keys.push(source.slice(index + 1, end))
      atKey = false
      index = end
      continue
    }
    if ("([{".includes(char)) {
      if (atKey && char === "[") keys.push("[computed]")
      atKey = false
      index = skipBalanced(source, index)
      continue
    }
    if (atKey && source.startsWith("...", index)) { keys.push("..."); atKey = false; index += 2; continue }
    if (atKey && /[A-Za-z_$]/.test(char)) {
      const name = source.slice(index).match(/^[A-Za-z_$][\w$]*/)[0]
      keys.push(name)
      atKey = false
      index += name.length - 1
      continue
    }
    atKey = false
  }
  throw new Error("unterminated object literal")
}

function skipString(source, start) {
  const quote = source[start]
  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index]
    if (char === "\\") { index += 1; continue }
    if (char === quote) return index
    if (quote === "`" && source.startsWith("${", index)) index = skipBalanced(source, index + 1)
  }
  throw new Error("unterminated string")
}

function skipBalanced(source, open) {
  let depth = 0
  for (let index = open; index < source.length; index += 1) {
    const char = source[index]
    if (char === '"' || char === "'" || char === "`") { index = skipString(source, index); continue }
    if ("([{".includes(char)) depth += 1
    else if (")]}".includes(char)) {
      depth -= 1
      if (depth === 0) return index
    }
  }
  throw new Error("unbalanced brackets")
}

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
// The handoff flags that btrain's own callers (pr-flow) pass to the handoff
// functions. Any other key they pass must be registered as internal-only, so
// a flag documented only for another command cannot slip through as a "flag".
const HANDOFF_FLAGS_PASSED_INTERNALLY = ["lane", "actor", "status", "pr", "next", "summary", "final", "base", "reason-code", "reason-tag"]

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

  it("rejects them on every handoff subcommand, in any spelling", async () => {
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
        ["--transitionEvent=watchdog-lock-release"],
      ]) {
        await assertRejected(repo, btrain("alpha", "handoff", "update", "--lane", "x", "--next", "n", ...option), option[0])
      }
    })
  })

  it("rejects them before resolving the repo or reading any state", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "btrain-cli-internal-norepo-"))
    const cwd = path.join(root, "work")
    await fs.mkdir(cwd)
    const run = (...args) => exec("node", [CLI, ...args], {
      cwd,
      env: { ...withoutLaneScope(), BRAIN_TRAIN_HOME: path.join(root, "home"), BTRAIN_AGENT: "alpha", BTRAIN_DASHBOARD_DISABLED: "1" },
    }).then(({ stderr }) => ({ code: 0, stderr }), (error) => ({ code: error.code, stderr: error.stderr || "" }))
    try {
      // No btrain repo is reachable from here (checked read-only), so a check
      // that ran after repo resolution would fail with this error instead.
      const clean = await run("handoff", "--lane", "x")
      assert.notEqual(clean.code, 0)
      assert.match(clean.stderr, /Could not find a bootstrapped repo/)

      const forged = await run("handoff", "update", "--lane", "x", "--next", "n", "--transitionEvent", "pr-poll")
      assert.notEqual(forged.code, 0)
      assert.match(forged.stderr, /`--transitionEvent` is internal to btrain/)
      assert.deepEqual(await fs.readdir(root), ["work"], "a command created files, including under BRAIN_TRAIN_HOME")
      assert.deepEqual(await fs.readdir(cwd), [], "a rejected command created files")
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
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
      "transitionEvent=pr-poll": true,
    })
    assert.deepEqual(found.map(({ flag, key }) => [flag, key]), [
      ["transition-event", "transitionEvent"],
      ["TRANSITION_COMPATIBILITY", "transitionCompatibility"],
      ["viaproutcome", "viaPrOutcome"],
      ["onEvent", "onEvent"],
      ["transitionEvent=pr-poll", "transitionEvent"],
    ])
    assert.deepEqual(findInternalOnlyOptions({ _: [], lane: "x", final: true, pr: "12", "repo=x": true }), [])
  })

  it("covers every option that btrain's own callers pass to the handoff functions", async () => {
    const { INTERNAL_ONLY_OPTIONS } = await import(INTERNAL_OPTIONS_MODULE)
    const help = (await exec("node", [CLI, "help"])).stdout
    for (const flag of HANDOFF_FLAGS_PASSED_INTERNALLY) {
      assert.match(help, new RegExp(`--${flag}(?![\\w-])`), `--${flag} is listed as a handoff flag, but btrain help does not document it`)
    }
    const problems = []
    const passed = new Set()
    for (const file of await listSourceFiles(path.resolve("src/brain_train"))) {
      // The CLI's own calls spread parseOptions output; parseOptions guards those.
      if (file.endsWith(`${path.sep}cli.mjs`)) continue
      const source = await fs.readFile(file, "utf8")
      for (const mention of findHandoffMentions(source)) {
        const where = `${path.relative(process.cwd(), file)}:${mention.line} ${mention.name}`
        if (mention.problem) problems.push(`${where}: ${mention.problem}`)
        for (const key of mention.keys || []) {
          passed.add(key)
          if (!HANDOFF_FLAGS_PASSED_INTERNALLY.includes(key) && !Object.hasOwn(INTERNAL_ONLY_OPTIONS, key)) {
            problems.push(`${where}: ${key}`)
          }
        }
      }
    }
    assert.deepEqual(
      problems,
      [],
      "call the handoff functions directly with an inline options literal, and register each new key in src/brain_train/internal_options.mjs (or, for a documented handoff flag, in HANDOFF_FLAGS_PASSED_INTERNALLY)",
    )
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

const HANDOFF_FUNCTION_NAMES = "claimHandoff|patchHandoff|requestChangesHandoff|resolveHandoff"
// `of` is left out: it is also a legal variable name, and a regex right after
// `for (x of` does not occur here.
const REGEX_KEYWORDS = ["return", "typeof", "case", "do", "else", "in", "new", "delete", "void", "throw", "yield", "await"]

// Every mention of the four handoff functions in one module, read from the
// code that maskNonCode leaves, so a comment or string neither hides a call
// nor counts as one. A mention must be a declaration, an import or export
// specifier without `as`, or a direct call whose options are an inline
// literal. Anything else (an alias, `?.(`, `.call`, a reference passed
// around) is reported, as is a string-named specifier or a namespace or
// dynamic import of core.mjs, whose computed access the scan cannot follow.
function findHandoffMentions(source) {
  if (!new RegExp(`\\b(?:${HANDOFF_FUNCTION_NAMES})\\b`).test(source) && !source.includes("core.mjs")) return []
  const masked = maskNonCode(source)
  const { code } = masked
  const lineOf = (index) => source.slice(0, index).split("\n").length
  const mentions = []
  const coreImports = /\bimport\s*\*\s*as\s+[\w$]+\s+from\s*["'][^"']*core\.mjs["']|\bimport\s*\(\s*["'][^"']*core\.mjs["']/g
  for (const match of source.matchAll(coreImports)) {
    if (code.startsWith("import", match.index)) {
      mentions.push({ name: "core.mjs", line: lineOf(match.index), problem: "namespace or dynamic import of core.mjs" })
    }
  }
  const specifierLists = [...code.matchAll(/^[ \t]*(?:import\s*\{[^}]*\}\s*from\b|export\s*\{[^}]*\})/gm)]
    .map((match) => [match.index, match.index + match[0].length])
  for (const [listStart, listEnd] of specifierLists) {
    if (new RegExp(`["'](?:${HANDOFF_FUNCTION_NAMES})["']`).test(source.slice(listStart, listEnd))) {
      mentions.push({ name: "specifier", line: lineOf(listStart), problem: "string-named import or export specifier" })
    }
  }
  for (const match of code.matchAll(new RegExp(`\\b(${HANDOFF_FUNCTION_NAMES})\\b`, "g"))) {
    const start = match.index
    const end = start + match[0].length
    if (/\bfunction\s*\*?\s*$/.test(code.slice(code.lastIndexOf("\n", start) + 1, start))) continue
    const mention = { name: match[1], line: lineOf(start) }
    const rest = code.slice(end, end + 200)
    if (specifierLists.some(([listStart, listEnd]) => start > listStart && end < listEnd)) {
      if (!/^\s+as\b/.test(rest)) continue
      mention.problem = "imported or exported under another name"
    } else if (!/^\s*\(/.test(rest)) {
      mention.problem = "not a direct call"
    } else {
      const args = rest.match(/^\s*\(\s*[\w$.]+\s*,\s*/)
      const open = args ? end + args[0].length : -1
      mention.keys = open >= 0 && code[open] === "{" ? objectLiteralKeys(source, masked, open) : null
      if (!mention.keys) mention.problem = "options are not an inline object literal"
    }
    mentions.push(mention)
  }
  return mentions
}

// The source with comments, strings, template text and regex literals
// blanked, plus each character's kind (0 code, 1 string, template text or
// regex, 2 comment). Newlines and template expressions are kept, so offsets
// and line numbers still match the source.
function maskNonCode(source) {
  const chars = source.split("")
  const kind = new Uint8Array(source.length)
  const blank = (from, to, as) => {
    for (let index = from; index <= to; index += 1) {
      kind[index] = as
      if (chars[index] !== "\n") chars[index] = " "
    }
  }
  // A `/` starts a regex literal unless the code before it ends a value.
  // Comments are skipped on the way back; a string, template or regex, a
  // postfix `++` or `--`, and a property or private field named like a
  // keyword (`a.in`, `this.#in`) end a value.
  const startsRegex = (slash) => {
    let index = slash - 1
    while (index >= 0 && (kind[index] === 2 || (kind[index] === 0 && /\s/.test(source[index])))) index -= 1
    if (index < 0) return true
    if (kind[index] === 1) return false
    const char = source[index]
    if ((char === "+" || char === "-") && source[index - 1] === char) return false
    if ("(,=:[!&|?{};+-*%<>~^".includes(char)) return true
    let wordStart = index
    while (wordStart > 0 && /[\w$]/.test(source[wordStart - 1])) wordStart -= 1
    if (source[wordStart - 1] === "." || source[wordStart - 1] === "#") return false
    return REGEX_KEYWORDS.includes(source.slice(wordStart, index + 1))
  }
  // Inside a template expression, stops at the `}` that closes it.
  const scanCode = (start, inTemplate) => {
    let depth = 0
    for (let index = start; index < source.length; index += 1) {
      const char = source[index]
      if (source.startsWith("//", index)) {
        const newline = source.indexOf("\n", index)
        const end = newline === -1 ? source.length - 1 : newline - 1
        blank(index, end, 2)
        index = end
      } else if (source.startsWith("/*", index)) {
        const close = source.indexOf("*/", index + 2)
        if (close === -1) throw new Error("unterminated comment")
        blank(index, close + 1, 2)
        index = close + 1
      } else if (char === '"' || char === "'") {
        const end = skipString(source, index)
        blank(index, end, 1)
        index = end
      } else if (char === "/" && startsRegex(index)) {
        const end = skipRegex(source, index)
        blank(index, end, 1)
        index = end
      } else if (char === "`") {
        index = maskTemplate(index)
      } else if (inTemplate && char === "{") {
        depth += 1
      } else if (inTemplate && char === "}") {
        if (depth === 0) return index
        depth -= 1
      }
    }
    if (inTemplate) throw new Error("unterminated template expression")
    return source.length
  }
  const maskTemplate = (start) => {
    let textStart = start
    for (let index = start + 1; index < source.length; index += 1) {
      if (source[index] === "\\") { index += 1; continue }
      if (source[index] === "`") {
        blank(textStart, index, 1)
        return index
      }
      if (source.startsWith("${", index)) {
        blank(textStart, index - 1, 1)
        // The `${` opens code, so a regex right after it still reads as one.
        chars[index] = " "
        chars[index + 1] = " "
        index = scanCode(index + 2, true)
        textStart = index
      }
    }
    throw new Error("unterminated template literal")
  }
  scanCode(0, false)
  return { code: chars.join(""), kind }
}

// The top-level keys of the object literal opening at `open`, read from the
// masked code so that strings, comments and regex literals cannot fake a
// bracket or a comma; quoted keys are read from the source. Returns null when
// the literal does not close right before `,` or `)`. Spreads, computed keys
// and anything else that is not a plain key are reported, never dropped.
function objectLiteralKeys(source, { code, kind }, open) {
  const keys = []
  let atKey = true
  let depth = 0
  for (let index = open + 1; index < code.length; index += 1) {
    const char = code[index]
    if (kind[index] === 2 || (kind[index] === 0 && /\s/.test(char))) continue
    if (depth > 0) {
      if ("([{".includes(char)) depth += 1
      else if (")]}".includes(char)) depth -= 1
      continue
    }
    if (char === "}") return /^\s*[,)]/.test(code.slice(index + 1, index + 100)) ? keys : null
    if (char === ",") { atKey = true; continue }
    if (!atKey) {
      if ("([{".includes(char)) depth += 1
      continue
    }
    atKey = false
    if (kind[index] === 1) {
      const quoted = source[index] === '"' || source[index] === "'"
      keys.push(quoted ? source.slice(index + 1, skipString(source, index)) : `[unparsed ${source[index]}]`)
    } else if (code.startsWith("...", index)) {
      keys.push("...")
      index += 2
    } else if (/[A-Za-z_$]/.test(char)) {
      const name = code.slice(index, index + 100).match(/^[A-Za-z_$][\w$]*/)[0]
      keys.push(name)
      index += name.length - 1
    } else {
      keys.push(char === "[" ? "[computed]" : `[unparsed ${char}]`)
      if ("([{".includes(char)) depth += 1
    }
  }
  throw new Error("unterminated object literal")
}

function skipString(source, start) {
  const quote = source[start]
  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index]
    if (char === "\\") { index += 1; continue }
    if (char === quote) return index
    if (char === "\n") break
  }
  throw new Error("unterminated string")
}

function skipRegex(source, start) {
  let inClass = false
  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index]
    if (char === "\\") { index += 1; continue }
    if (char === "\n") break
    if (inClass) {
      if (char === "]") inClass = false
      continue
    }
    if (char === "[") { inClass = true; continue }
    if (char === "/") {
      while (/[A-Za-z]/.test(source[index + 1] || "")) index += 1
      return index
    }
  }
  throw new Error("unterminated regex literal")
}

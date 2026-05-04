import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import {
  parseUnifiedDiff,
  lineHasAllow,
  scanDiff,
  formatSummary,
  reviewCode,
} from "../src/brain_train/review/code-rules.mjs"

const execFileAsync = promisify(execFile)

// Synthetic secret-like strings, built at runtime so they aren't literal in
// the source (avoids github secret-scanning false positives in CI).
const FAKE = {
  aws: "AKIA" + "Z".repeat(16),
  stripe: "sk_" + "live_" + "z".repeat(24),
  openai: "sk-" + "z".repeat(40),
  anthropic: "sk-ant-" + "z".repeat(32),
  slack: "xoxb-" + "0".repeat(11),
  bearer: "Bearer " + "z".repeat(24),
  longLiteral: "notarealkey_synthetic_" + "z".repeat(16),
}

// Synthesize a minimal unified-diff snippet for one file with the given
// added lines (line numbers start at 1).
function makeDiff(filePath, addedLines, { startLine = 1 } = {}) {
  const header = [
    `diff --git a/${filePath} b/${filePath}`,
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
    `@@ -0,0 +${startLine},${addedLines.length} @@`,
  ].join("\n")
  const body = addedLines.map((line) => `+${line}`).join("\n")
  return `${header}\n${body}\n`
}

async function git(cwd, args) {
  return execFileAsync("git", args, { cwd })
}

describe("parseUnifiedDiff", () => {
  it("returns [] on empty input", () => {
    assert.deepEqual(parseUnifiedDiff(""), [])
  })

  it("extracts file path and added lines with correct line numbers", () => {
    const diff = makeDiff("src/foo.ts", ["const a = 1", "const b = 2"])
    const out = parseUnifiedDiff(diff)
    assert.equal(out.length, 1)
    assert.equal(out[0].file, "src/foo.ts")
    assert.deepEqual(out[0].added, [
      { line: 1, text: "const a = 1" },
      { line: 2, text: "const b = 2" },
    ])
  })

  it("handles multiple files in one diff", () => {
    const diff = makeDiff("a.ts", ["x"]) + makeDiff("b.ts", ["y"])
    const out = parseUnifiedDiff(diff)
    assert.equal(out.length, 2)
    assert.equal(out[0].file, "a.ts")
    assert.equal(out[1].file, "b.ts")
  })

  it("skips removed and context lines without inflating new-file line numbers", () => {
    const diff = [
      "diff --git a/x b/x",
      "--- a/x",
      "+++ b/x",
      "@@ -10,3 +10,3 @@",
      " context-line",
      "-removed-line",
      "+added-replacement",
    ].join("\n")
    const out = parseUnifiedDiff(diff)
    assert.equal(out[0].added.length, 1)
    assert.equal(out[0].added[0].line, 11) // 10 + 1 context line = 11
  })

  it("keeps added source lines that start with diff header-like text", () => {
    const diff = [
      "diff --git a/x b/x",
      "--- a/x",
      "+++ b/x",
      "@@ -1,2 +1,3 @@",
      " context-line",
      "++++ literal-plus-prefix",
      "+--- literal-minus-prefix",
      "+after",
    ].join("\n")
    const out = parseUnifiedDiff(diff)
    assert.deepEqual(out[0].added, [
      { line: 2, text: "+++ literal-plus-prefix" },
      { line: 3, text: "--- literal-minus-prefix" },
      { line: 4, text: "after" },
    ])
  })
})

describe("lineHasAllow", () => {
  it("matches // btrain-allow: rule-id", () => {
    assert.equal(lineHasAllow("foo // btrain-allow: cors-wildcard", "cors-wildcard"), true)
    assert.equal(lineHasAllow("foo // btrain-allow: cors-wildcard", "hardcoded-secret"), false)
  })

  it("matches # btrain-allow: rule-id (Python/shell comment)", () => {
    assert.equal(lineHasAllow("API_KEY = '...' # btrain-allow: env-var-required", "env-var-required"), true)
  })

  it("supports a comma-separated list of rule ids", () => {
    const text = "X // btrain-allow: cors-wildcard, hardcoded-secret"
    assert.equal(lineHasAllow(text, "cors-wildcard"), true)
    assert.equal(lineHasAllow(text, "hardcoded-secret"), true)
    assert.equal(lineHasAllow(text, "env-var-required"), false)
  })

  it("is case-insensitive on the marker but case-sensitive on rule ids only via lowercase normalization", () => {
    assert.equal(lineHasAllow("// BTRAIN-ALLOW: cors-wildcard", "cors-wildcard"), true)
  })

  it("returns false on lines without the marker", () => {
    assert.equal(lineHasAllow("just a normal comment", "cors-wildcard"), false)
  })
})

describe("hardcoded-secret rule", () => {
  it("flags an AWS access key id", () => {
    const diff = makeDiff("src/aws.ts", [`const k = "${FAKE.aws}"`])
    const { violations, summary } = scanDiff(diff)
    assert.equal(summary.hard, 1)
    assert.equal(violations[0].rule, "hardcoded-secret")
    assert.equal(violations[0].file, "src/aws.ts")
    assert.equal(violations[0].line, 1)
  })

  it("flags a Stripe live key", () => {
    const diff = makeDiff("src/pay.ts", [`const k = "${FAKE.stripe}"`])
    const { summary } = scanDiff(diff)
    assert.equal(summary.hard, 1)
  })

  it("flags an Anthropic key", () => {
    const diff = makeDiff("src/llm.ts", [`ANTHROPIC_API_KEY = "${FAKE.anthropic}"`])
    const { summary } = scanDiff(diff)
    assert.equal(summary.hard, 1)
  })

  it("flags an OpenAI-style key", () => {
    const diff = makeDiff("src/llm.ts", [`const k = "${FAKE.openai}"`])
    const { summary } = scanDiff(diff)
    assert.equal(summary.hard, 1)
  })

  it("flags a Bearer token", () => {
    const diff = makeDiff("src/auth.ts", [`headers["Authorization"] = "${FAKE.bearer}"`])
    const { summary } = scanDiff(diff)
    assert.equal(summary.hard, 1)
  })

  it("does NOT flag obviously safe lines", () => {
    const diff = makeDiff("src/safe.ts", [
      "const k = process.env.ANTHROPIC_API_KEY",
      'const x = "this is just a plain string"',
      'const y = "AKIA-not-a-key"',
    ])
    const { summary } = scanDiff(diff)
    assert.equal(summary.hard, 0)
  })

  it("respects // btrain-allow: hardcoded-secret on the same line", () => {
    const diff = makeDiff("test/fixtures.ts", [
      `const k = "${FAKE.aws}" // btrain-allow: hardcoded-secret`,
    ])
    const { summary } = scanDiff(diff)
    assert.equal(summary.hard, 0)
  })

  it("respects an allow marker on the previous line", () => {
    const diff = makeDiff("test/fixtures.ts", [
      "// btrain-allow: hardcoded-secret",
      `const k = "${FAKE.aws}"`,
    ])
    const { summary } = scanDiff(diff)
    assert.equal(summary.hard, 0)
  })

  it("respects an allow marker on a previous context line", () => {
    const diff = [
      "diff --git a/test/fixtures.ts b/test/fixtures.ts",
      "--- a/test/fixtures.ts",
      "+++ b/test/fixtures.ts",
      "@@ -1,1 +1,2 @@",
      " // btrain-allow: hardcoded-secret",
      `+const k = "${FAKE.aws}"`,
    ].join("\n")
    const { summary } = scanDiff(`${diff}\n`)
    assert.equal(summary.hard, 0)
  })
})

describe("cors-wildcard rule", () => {
  it("flags an Access-Control-Allow-Origin: * header line", () => {
    const diff = makeDiff("src/server.ts", ['res.setHeader("Access-Control-Allow-Origin", "*")'])
    const { violations, summary } = scanDiff(diff)
    assert.equal(summary.hard, 1)
    assert.equal(violations[0].rule, "cors-wildcard")
  })

  it("flags an inline cors({ origin: '*' }) call", () => {
    const diff = makeDiff("src/server.ts", ["app.use(cors({ origin: '*', credentials: false }))"])
    const { summary } = scanDiff(diff)
    assert.equal(summary.hard, 1)
  })

  it("does NOT flag a specific origin", () => {
    const diff = makeDiff("src/server.ts", [
      "app.use(cors({ origin: 'https://app.example.com', credentials: true }))",
    ])
    const { summary } = scanDiff(diff)
    assert.equal(summary.hard, 0)
  })

  it("respects // btrain-allow: cors-wildcard", () => {
    const diff = makeDiff("src/server.ts", [
      "app.use(cors({ origin: '*' })) // btrain-allow: cors-wildcard",
    ])
    const { summary } = scanDiff(diff)
    assert.equal(summary.hard, 0)
  })
})

describe("env-var-required rule", () => {
  it("flags a SECRET-named var assigned to a long literal", () => {
    const diff = makeDiff("src/config.ts", [
      `const STRIPE_SECRET = "${FAKE.longLiteral}"`,
    ])
    const { violations, summary } = scanDiff(diff)
    assert.equal(summary.warn, 1)
    assert.equal(violations[0].rule, "env-var-required")
  })

  it("does NOT flag if the value is from process.env", () => {
    const diff = makeDiff("src/config.ts", [
      "const STRIPE_SECRET = process.env.STRIPE_SECRET",
    ])
    const { summary } = scanDiff(diff)
    assert.equal(summary.warn, 0)
  })

  it("does NOT flag if a known secret pattern already fires (avoid double-flagging)", () => {
    // The Stripe key pattern fires hardcoded-secret; env-var-required should yield to it.
    const diff = makeDiff("src/config.ts", [
      `const STRIPE_SECRET = "${FAKE.stripe}"`,
    ])
    const { summary } = scanDiff(diff)
    assert.equal(summary.hard, 1)
    assert.equal(summary.warn, 0)
  })

  it("respects # btrain-allow: env-var-required", () => {
    const diff = makeDiff("src/config.py", [
      `STRIPE_SECRET = "${FAKE.longLiteral}"  # btrain-allow: env-var-required`,
    ])
    const { summary } = scanDiff(diff)
    assert.equal(summary.warn, 0)
  })
})

describe("unprotected-route rule", () => {
  it("flags a new Express route without a helmet/security import in the file", () => {
    const diff = makeDiff("src/server.ts", [
      "import express from 'express'",
      "const app = express()",
      "app.get('/api/foo', (req, res) => res.json({}))",
    ])
    const { violations, summary } = scanDiff(diff)
    assert.equal(summary.warn, 1)
    assert.equal(violations[0].rule, "unprotected-route")
  })

  it("does NOT flag when the file imports helmet", () => {
    const diff = makeDiff("src/server.ts", [
      "import helmet from 'helmet'",
      "app.use(helmet())",
      "app.get('/api/foo', (req, res) => res.json({}))",
    ])
    const { summary } = scanDiff(diff)
    assert.equal(summary.warn, 0)
  })

  it("does NOT flag when the file sets a security header explicitly", () => {
    const diff = makeDiff("src/server.ts", [
      "res.setHeader('Strict-Transport-Security', 'max-age=31536000')",
      "app.get('/api/foo', (req, res) => res.json({}))",
    ])
    const { summary } = scanDiff(diff)
    assert.equal(summary.warn, 0)
  })

  it("respects // btrain-allow: unprotected-route on the route line", () => {
    const diff = makeDiff("src/server.ts", [
      "app.get('/api/foo', (req, res) => res.json({})) // btrain-allow: unprotected-route",
    ])
    const { summary } = scanDiff(diff)
    assert.equal(summary.warn, 0)
  })

  it("does not fire when no route handlers were added", () => {
    const diff = makeDiff("src/utils.ts", [
      "function add(a, b) { return a + b }",
    ])
    const { summary } = scanDiff(diff)
    assert.equal(summary.warn, 0)
  })
})

describe("new-dependency rule", () => {
  it("flags an added line in package.json dependencies", () => {
    const diff = makeDiff("package.json", ['    "lodash": "^4.17.0",'], { startLine: 3 })
    const { violations, summary } = scanDiff(diff, {
      fileContentsByPath: {
        "package.json": [
          "{",
          '  "dependencies": {',
          '    "lodash": "^4.17.0",',
          "  }",
          "}",
        ].join("\n"),
      },
    })
    assert.equal(summary.warn, 1)
    assert.equal(violations[0].rule, "new-dependency")
  })

  it("does not flag package.json string pairs outside dependency sections", () => {
    const diff = makeDiff("package.json", ['    "lint": "eslint ."'], { startLine: 3 })
    const { summary } = scanDiff(diff, {
      fileContentsByPath: {
        "package.json": [
          "{",
          '  "scripts": {',
          '    "lint": "eslint ."',
          "  }",
          "}",
        ].join("\n"),
      },
    })
    assert.equal(summary.warn, 0)
  })

  it("does not let an empty package.json dependency section bleed into scripts", () => {
    const diff = makeDiff("package.json", ['    "lint": "eslint ."'], { startLine: 4 })
    const { summary } = scanDiff(diff, {
      fileContentsByPath: {
        "package.json": [
          "{",
          '  "dependencies": {},',
          '  "scripts": {',
          '    "lint": "eslint ."',
          "  }",
          "}",
        ].join("\n"),
      },
    })
    assert.equal(summary.warn, 0)
  })

  it("flags an added line in requirements.txt", () => {
    const diff = makeDiff("requirements.txt", ["requests>=2.31"])
    const { summary } = scanDiff(diff)
    assert.equal(summary.warn, 1)
  })

  it("flags an added line in Cargo.toml", () => {
    const diff = makeDiff("Cargo.toml", ['serde = "1.0"'])
    const { summary } = scanDiff(diff)
    assert.equal(summary.warn, 1)
  })

  it("flags an added line in go.mod", () => {
    const diff = makeDiff("go.mod", ["github.com/foo/bar v1.2.3"])
    const { summary } = scanDiff(diff)
    assert.equal(summary.warn, 1)
  })

  it("flags a single-line go.mod require directive", () => {
    const diff = makeDiff("go.mod", ["require github.com/foo/bar v1.2.3"])
    const { summary } = scanDiff(diff)
    assert.equal(summary.warn, 1)
  })

  it("ignores comment-only added lines in requirements.txt", () => {
    const diff = makeDiff("requirements.txt", ["# pinned for security"])
    const { summary } = scanDiff(diff)
    assert.equal(summary.warn, 0)
  })

  it("does not flag random source files", () => {
    const diff = makeDiff("src/server.ts", ['"react": "^18.0.0",'])
    const { summary } = scanDiff(diff)
    assert.equal(summary.warn, 0)
  })

  it("respects // btrain-allow: new-dependency", () => {
    const diff = makeDiff("package.json", ['    "lodash": "^4.17.0", // btrain-allow: new-dependency'], { startLine: 3 })
    const { summary } = scanDiff(diff, {
      fileContentsByPath: {
        "package.json": [
          "{",
          '  "dependencies": {',
          '    "lodash": "^4.17.0", // btrain-allow: new-dependency',
          "  }",
          "}",
        ].join("\n"),
      },
    })
    assert.equal(summary.warn, 0)
  })

  it("respects a previous-line allow marker for dependency manifests", () => {
    const diff = makeDiff("requirements.txt", [
      "# btrain-allow: new-dependency",
      "requests>=2.31",
    ])
    const { summary } = scanDiff(diff)
    assert.equal(summary.warn, 0)
  })

  it("respects a previous context-line allow marker for dependency manifests", () => {
    const diff = [
      "diff --git a/requirements.txt b/requirements.txt",
      "--- a/requirements.txt",
      "+++ b/requirements.txt",
      "@@ -1,1 +1,2 @@",
      " # btrain-allow: new-dependency",
      "+requests>=2.31",
    ].join("\n")
    const { summary } = scanDiff(`${diff}\n`)
    assert.equal(summary.warn, 0)
  })
})

describe("reviewCode lane scoping", () => {
  it("limits the scanned diff to files locked by the requested lane", async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), "btrain-review-code-"))
    try {
      await git(repo, ["init"])
      await git(repo, ["config", "user.email", "codex@example.com"])
      await git(repo, ["config", "user.name", "Codex"])
      await fs.mkdir(path.join(repo, ".btrain"), { recursive: true })
      await fs.mkdir(path.join(repo, "src"), { recursive: true })
      await fs.writeFile(
        path.join(repo, ".btrain", "project.toml"),
        [
          "[project]",
          'name = "review-code-test"',
          "",
          "[lanes]",
          "enabled = true",
          'ids = ["e"]',
        ].join("\n"),
      )
      await fs.writeFile(
        path.join(repo, ".btrain", "locks.json"),
        JSON.stringify({
          version: 1,
          locks: [{ path: "src/lane.js", lane: "e", owner: "codex", acquired_at: "2026-05-04T00:00:00.000Z" }],
        }),
      )
      await fs.writeFile(path.join(repo, "src", "lane.js"), "export const lane = 1\n")
      await fs.writeFile(path.join(repo, "src", "other.js"), "export const other = 1\n")
      await git(repo, ["add", "."])
      await git(repo, ["commit", "-m", "baseline"])

      await fs.writeFile(path.join(repo, "src", "lane.js"), "export const lane = 2\n")
      await fs.writeFile(path.join(repo, "src", "other.js"), `export const leaked = "${FAKE.aws}"\n`)

      const scoped = await reviewCode(repo, { base: "HEAD", lane: "e" })
      assert.deepEqual(scoped.summary, { hard: 0, warn: 0 })
      assert.deepEqual(scoped.violations, [])
    } finally {
      await fs.rm(repo, { recursive: true, force: true })
    }
  })

  it("honors --head without requiring --base", async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), "btrain-review-code-head-"))
    try {
      await git(repo, ["init"])
      await git(repo, ["config", "user.email", "codex@example.com"])
      await git(repo, ["config", "user.name", "Codex"])
      await fs.mkdir(path.join(repo, "src"), { recursive: true })
      await fs.writeFile(path.join(repo, "src", "config.js"), "export const ok = true\n")
      await git(repo, ["add", "."])
      await git(repo, ["commit", "-m", "baseline"])

      await fs.writeFile(path.join(repo, "src", "config.js"), `export const token = "${FAKE.aws}"\n`)
      await git(repo, ["add", "."])
      await git(repo, ["commit", "-m", "add token"])

      const result = await reviewCode(repo, { head: "HEAD~1" })
      assert.equal(result.summary.hard, 1)
      assert.equal(result.violations[0].rule, "hardcoded-secret")
    } finally {
      await fs.rm(repo, { recursive: true, force: true })
    }
  })
})

describe("scanDiff aggregation", () => {
  it("returns empty result on empty diff", () => {
    const { violations, summary } = scanDiff("")
    assert.deepEqual(violations, [])
    assert.deepEqual(summary, { hard: 0, warn: 0 })
  })

  it("returns sorted violations by file, then line, then rule", () => {
    const diff =
      makeDiff("z.ts", [`const k = "${FAKE.aws}"`]) +
      makeDiff("a.ts", [
        "app.use(cors({ origin: '*' }))",
        `const k = "${FAKE.aws}"`,
      ])
    const { violations } = scanDiff(diff)
    // a.ts comes before z.ts, lines in order
    assert.equal(violations[0].file, "a.ts")
    assert.equal(violations[0].line, 1)
    assert.equal(violations[1].file, "a.ts")
    assert.equal(violations[1].line, 2)
    assert.equal(violations[2].file, "z.ts")
  })

  it("counts hard vs warn correctly across multiple files", () => {
    const diff =
      makeDiff("src/server.ts", ["app.use(cors({ origin: '*' }))"]) +
      makeDiff("requirements.txt", ["new-package"])
    const { summary } = scanDiff(diff)
    assert.equal(summary.hard, 1)
    assert.equal(summary.warn, 1)
  })
})

describe("formatSummary", () => {
  it("reports clean when no violations", () => {
    const out = formatSummary({ violations: [], summary: { hard: 0, warn: 0 } })
    assert.match(out, /0 hard, 0 warn/)
    assert.match(out, /no violations/)
  })

  it("reports hard violations with ✖", () => {
    const result = scanDiff(makeDiff("a.ts", [`const k = "${FAKE.aws}"`]))
    const out = formatSummary(result)
    assert.match(out, /1 hard, 0 warn/)
    assert.match(out, /✖.*hardcoded-secret/)
    assert.match(out, /a\.ts:1/)
  })

  it("reports warn violations with ⚠", () => {
    const result = scanDiff(makeDiff("requirements.txt", ["requests>=2.31"]))
    const out = formatSummary(result)
    assert.match(out, /0 hard, 1 warn/)
    assert.match(out, /⚠.*new-dependency/)
  })
})

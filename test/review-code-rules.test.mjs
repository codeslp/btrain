import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { execFile, execFileSync } from "node:child_process"
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
    const diff = makeDiff("src/llm.ts", [`ANTHROPIC_API_KEY = "${FAKE.anthropic}"`]) // btrain-allow: env-var-required
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
  // btrain-allow: cors-wildcard
  it("flags an Access-Control-Allow-Origin: * header line", () => {
    const diff = makeDiff("src/server.ts", ['res.setHeader("Access-Control-Allow-Origin", "*")']) // btrain-allow: cors-wildcard
    const { violations, summary } = scanDiff(diff)
    assert.equal(summary.hard, 1)
    assert.equal(violations[0].rule, "cors-wildcard")
  })

  // btrain-allow: cors-wildcard
  it("flags an inline cors({ origin: '*' }) call", () => {
    const diff = makeDiff("src/server.ts", ["app.use(cors({ origin: '*', credentials: false }))"]) // btrain-allow: cors-wildcard
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
      `const STRIPE_SECRET = "${FAKE.longLiteral}"`, // btrain-allow: env-var-required
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
      `const STRIPE_SECRET = "${FAKE.stripe}"`, // btrain-allow: env-var-required
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

  it("continues scanning routes after an allowed route line", () => {
    const diff = makeDiff("src/server.ts", [
      "app.get('/api/fixture', (req, res) => res.json({})) // btrain-allow: unprotected-route",
      "app.post('/api/live', (req, res) => res.json({}))",
    ])
    const { violations, summary } = scanDiff(diff)
    assert.equal(summary.warn, 1)
    assert.equal(violations[0].rule, "unprotected-route")
    assert.equal(violations[0].line, 2)
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
    const diff = makeDiff("Cargo.toml", ["[dependencies]", 'serde = "1.0"'])
    const { summary } = scanDiff(diff)
    assert.equal(summary.warn, 1)
  })

  it("does not flag Cargo.toml metadata outside dependency sections", () => {
    const diff = makeDiff("Cargo.toml", ['version = "0.2.0"'], { startLine: 2 })
    const { summary } = scanDiff(diff, {
      fileContentsByPath: {
        "Cargo.toml": [
          "[package]",
          'version = "0.2.0"',
        ].join("\n"),
      },
    })
    assert.equal(summary.warn, 0)
  })

  it("flags an added line in pyproject.toml dependency sections", () => {
    const diff = makeDiff("pyproject.toml", ["[tool.poetry.dependencies]", 'requests = "^2.31"'])
    const { summary } = scanDiff(diff)
    assert.equal(summary.warn, 1)
  })

  it("flags project dependencies in pyproject.toml without treating all project keys as dependencies", () => {
    const diff = makeDiff("pyproject.toml", ['dependencies = ["requests>=2.31"]'], { startLine: 2 })
    const { summary } = scanDiff(diff, {
      fileContentsByPath: {
        "pyproject.toml": [
          "[project]",
          'dependencies = ["requests>=2.31"]',
        ].join("\n"),
      },
    })
    assert.equal(summary.warn, 1)
  })

  it("flags project dependencies added inside existing pyproject dependency arrays", () => {
    const diff = [
      "diff --git a/pyproject.toml b/pyproject.toml",
      "--- a/pyproject.toml",
      "+++ b/pyproject.toml",
      "@@ -1,3 +1,4 @@",
      " [project]",
      " dependencies = [",
      "+  \"urllib3>=2\",",
      " ]",
    ].join("\n")
    const { summary } = scanDiff(`${diff}\n`)
    assert.equal(summary.warn, 1)
  })

  it("does not flag pyproject.toml project metadata outside dependency sections", () => {
    const diff = makeDiff("pyproject.toml", ['version = "0.2.0"'], { startLine: 2 })
    const { summary } = scanDiff(diff, {
      fileContentsByPath: {
        "pyproject.toml": [
          "[project]",
          'version = "0.2.0"',
        ].join("\n"),
      },
    })
    assert.equal(summary.warn, 0)
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

  it("reads dependency manifest context from the worktree for --head without --base", async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), "btrain-review-code-head-deps-"))
    try {
      await git(repo, ["init"])
      await git(repo, ["config", "user.email", "codex@example.com"])
      await git(repo, ["config", "user.name", "Codex"])
      await fs.writeFile(path.join(repo, "package.json"), ["{", "  \"scripts\": {}", "}"].join("\n"))
      await git(repo, ["add", "."])
      await git(repo, ["commit", "-m", "baseline"])

      await fs.writeFile(
        path.join(repo, "package.json"),
        [
          "{",
          "  \"scripts\": {},",
          "  \"dependencies\": {",
          "    \"lodash\": \"^4.17.0\"",
          "  }",
          "}",
        ].join("\n"),
      )
      await git(repo, ["add", "."])
      await git(repo, ["commit", "-m", "add dependency"])

      const result = await reviewCode(repo, { head: "HEAD~1" })
      assert.equal(result.summary.warn, 1)
      assert.equal(result.violations[0].rule, "new-dependency")
    } finally {
      await fs.rm(repo, { recursive: true, force: true })
    }
  })

  it("includes staged-only changes in the default scan", async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), "btrain-review-code-staged-"))
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

      const result = await reviewCode(repo)
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
        "app.use(cors({ origin: '*' }))", // btrain-allow: cors-wildcard
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
      makeDiff("src/server.ts", ["app.use(cors({ origin: '*' }))"]) + // btrain-allow: cors-wildcard
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

// ---- weakened-test rules ----

// Trigger words assembled at runtime, like FAKE above, so this file's own diff
// does not trip the rules it exercises when `btrain review code` scans it.
const T = {
  skip: "sk" + "ip",
  only: "on" + "ly",
  todo: "to" + "do",
  fixme: "fix" + "me",
  xit: "x" + "it",
  fit: "f" + "it",
  fdescribe: "f" + "describe",
  xdescribe: "x" + "describe",
  pytestSkip: "@pytest.mark." + "skip",
  unittestSkip: "@unittest." + "skip",
}

// Build a one-hunk diff from lines that already carry their " ", "-" or "+"
// prefix. Header lines (rename, delete) follow `diff --git` as git emits them.
function makeHunkDiff(filePath, hunkLines, { oldStart = 1, newStart = 1, headers = [], oldPath = filePath } = {}) {
  const oldCount = hunkLines.filter((line) => !line.startsWith("+")).length
  const newCount = hunkLines.filter((line) => !line.startsWith("-")).length
  return [
    `diff --git a/${oldPath} b/${filePath}`,
    ...headers,
    `--- a/${oldPath}`,
    `+++ b/${filePath}`,
    `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`,
    ...hunkLines,
  ].join("\n") + "\n"
}

function makeDeletedDiff(filePath, removedLines) {
  return [
    `diff --git a/${filePath} b/${filePath}`,
    "deleted file mode 100644",
    "index 1111111..0000000",
    `--- a/${filePath}`,
    "+++ /dev/null",
    `@@ -1,${removedLines.length} +0,0 @@`,
    ...removedLines.map((line) => `-${line}`),
  ].join("\n") + "\n"
}

function makeRenameDiff(oldPath, newPath) {
  return [
    `diff --git a/${oldPath} b/${newPath}`,
    "similarity index 100%",
    `rename from ${oldPath}`,
    `rename to ${newPath}`,
  ].join("\n") + "\n"
}

function findingsFor(result, rule) {
  return result.violations.filter((violation) => violation.rule === rule)
}

describe("parseUnifiedDiff file headers and removed lines", () => {
  it("records deleted, renamed and new files with their old path", () => {
    const newFile = [
      "diff --git a/test/fresh.test.mjs b/test/fresh.test.mjs",
      "new file mode 100644",
      "index 0000000..1111111",
      "--- /dev/null",
      "+++ b/test/fresh.test.mjs",
      "@@ -0,0 +1,1 @@",
      "+it('fresh', () => {})",
    ].join("\n")
    const diff =
      makeDeletedDiff("test/gone.test.mjs", ["it('a', () => {})", "  assert.ok(true)"]) +
      makeRenameDiff("test/old.test.mjs", "test/old-helper.mjs") +
      `${newFile}\n`
    const [gone, renamed, fresh] = parseUnifiedDiff(diff)
    assert.equal(gone.status, "deleted")
    assert.equal(gone.file, "test/gone.test.mjs")
    assert.deepEqual(gone.removed, [
      { line: 1, text: "it('a', () => {})" },
      { line: 2, text: "  assert.ok(true)" },
    ])
    assert.deepEqual(gone.added, [])
    assert.equal(renamed.status, "renamed")
    assert.equal(renamed.oldFile, "test/old.test.mjs")
    assert.equal(renamed.file, "test/old-helper.mjs")
    assert.deepEqual(renamed.hunks, [])
    assert.equal(fresh.status, "added")
    assert.equal(fresh.oldFile, "test/fresh.test.mjs")
  })

  it("collects removed lines with old line numbers and per-hunk added and removed lists", () => {
    const diff = [
      "diff --git a/x.mjs b/x.mjs",
      "--- a/x.mjs",
      "+++ b/x.mjs",
      "@@ -10,3 +10,3 @@",
      " keep",
      "-old-11",
      "+new-11",
      " keep",
      "@@ -40,2 +40,1 @@",
      " keep",
      "-old-41",
    ].join("\n")
    const [entry] = parseUnifiedDiff(`${diff}\n`)
    assert.equal(entry.status, "modified")
    assert.deepEqual(entry.removed, [
      { line: 11, text: "old-11" },
      { line: 41, text: "old-41" },
    ])
    assert.equal(entry.hunks.length, 2)
    assert.deepEqual(entry.hunks[0].removed, [{ line: 11, text: "old-11" }])
    assert.deepEqual(entry.hunks[0].added, [{ line: 11, text: "new-11" }])
    assert.deepEqual(entry.hunks[1].removed, [{ line: 41, text: "old-41" }])
    assert.deepEqual(entry.hunks[1].added, [])
    // A removed entry's newLine is the new-file line at the removal point.
    assert.deepEqual(
      entry.hunks[1].entries.map(({ kind, oldLine, newLine }) => [kind, oldLine, newLine]),
      [["context", 40, 40], ["removed", 41, 41]],
    )
  })

  it("keeps the legacy file, added and lines output byte-for-byte", () => {
    const diff = [
      "diff --git a/test/old.test.mjs b/test/new.test.mjs",
      "similarity index 90%",
      "rename from test/old.test.mjs",
      "rename to test/new.test.mjs",
      "index 1111111..2222222 100644",
      "--- a/test/old.test.mjs",
      "+++ b/test/new.test.mjs",
      "@@ -3,4 +3,4 @@ describe(\"x\", () => {",
      " keep-a",
      "-drop-b",
      "+add-b",
      " keep-c",
      "-drop-d",
      "\\ No newline at end of file",
      "+add-d",
      "\\ No newline at end of file",
      "diff --git a/gone.mjs b/gone.mjs",
      "deleted file mode 100644",
      "index 3333333..0000000",
      "--- a/gone.mjs",
      "+++ /dev/null",
      "@@ -1,2 +0,0 @@",
      "-one",
      "-two",
      "",
    ].join("\n")
    // Captured from the parser before removed lines and file headers were read.
    const legacy =
      '[{"file":"test/new.test.mjs","added":[{"line":4,"text":"add-b"},{"line":6,"text":"add-d"}],' +
      '"lines":[{"line":3,"text":"keep-a","kind":"context"},{"line":4,"text":"add-b","kind":"added"},' +
      '{"line":5,"text":"keep-c","kind":"context"},{"line":6,"text":"add-d","kind":"added"}]},' +
      '{"file":"gone.mjs","added":[],"lines":[]}]'
    const projected = parseUnifiedDiff(diff).map(({ file, added, lines }) => ({ file, added, lines }))
    assert.equal(JSON.stringify(projected), legacy)
  })

  it("does not run the original added-line rules on removed lines", () => {
    const diff = makeHunkDiff("src/config.ts", [`-const k = "${FAKE.aws}"`, "+const k = process.env.AWS_KEY"])
    assert.deepEqual(scanDiff(diff).summary, { hard: 0, warn: 0 })
  })

  it("unquotes paths that git wraps in quotes", () => {
    const diff = [
      'diff --git "a/test/caf\\303\\251.test.mjs" "b/test/caf\\303\\251.test.mjs"',
      "deleted file mode 100644",
      "index 1111111..0000000",
      '--- "a/test/caf\\303\\251.test.mjs"',
      "+++ /dev/null",
      "@@ -1,1 +0,0 @@",
      "-it('a', () => {})",
    ].join("\n")
    const [entry] = parseUnifiedDiff(`${diff}\n`)
    assert.equal(entry.file, "test/café.test.mjs")
    assert.equal(entry.status, "deleted")
  })
})

describe("deleted-test-file rule", () => {
  it("flags a deleted test file", () => {
    const result = scanDiff(makeDeletedDiff("test/cache.test.mjs", ['it("evicts", () => {', "  assert.equal(size(), 0)", "})"]))
    assert.deepEqual(result.summary, { hard: 0, warn: 1 })
    const [finding] = result.violations
    assert.equal(finding.rule, "deleted-test-file")
    assert.equal(finding.severity, "warn")
    assert.equal(finding.file, "test/cache.test.mjs")
    assert.equal(finding.line, 0)
    assert.match(finding.detail, /1 assertion line/)
  })

  it("flags a deleted Python test module", () => {
    const result = scanDiff(makeDeletedDiff("agentchattr/tests/test_router.py", ["def test_route():", "    assert route() == 1"]))
    assert.equal(findingsFor(result, "deleted-test-file").length, 1)
  })

  it("flags a test file renamed to a non-test path", () => {
    const result = scanDiff(makeRenameDiff("test/cache.test.mjs", "test/cache-fixtures.mjs"))
    const [finding, ...rest] = findingsFor(result, "deleted-test-file")
    assert.equal(rest.length, 0)
    assert.equal(finding.file, "test/cache.test.mjs")
    assert.match(finding.preview, /test\/cache-fixtures\.mjs/)
  })

  it("does not flag deleted helpers, deleted source files, or test-to-test renames", () => {
    const result = scanDiff(
      makeDeletedDiff("test/helpers/runner-scope.mjs", ["export const scope = 1"]) +
      makeDeletedDiff("src/old-cache.mjs", ["export const size = 0"]) +
      makeRenameDiff("test/cache.test.mjs", "test/cache-eviction.test.mjs"),
    )
    assert.deepEqual(result.violations, [])
  })
})

describe("removed-assertion rule", () => {
  it("flags a test hunk that removes more assertion lines than it adds", () => {
    const diff = makeHunkDiff("test/cache.test.mjs", [
      '   it("evicts the oldest entry", () => {',
      '     cache.set("a", 1)',
      "     assert.equal(cache.size, 1)",
      '-    assert.equal(cache.get("a"), 1)',
      '-    assert.ok(cache.has("a"))',
      "   })",
    ], { oldStart: 10, newStart: 10 })
    const result = scanDiff(diff)
    assert.deepEqual(result.summary, { hard: 0, warn: 1 })
    const [finding] = result.violations
    assert.equal(finding.rule, "removed-assertion")
    assert.equal(finding.line, 13)
    assert.match(finding.detail, /removes 2 assertion lines and adds 0/)
  })

  it("counts a commented-out assertion as removed", () => {
    const diff = makeHunkDiff("test/cache.test.mjs", [
      "-    assert.equal(cache.size, 1)",
      "+    // assert.equal(cache.size, 1)",
    ])
    assert.equal(findingsFor(scanDiff(diff), "removed-assertion").length, 1)
  })

  it("flags removed unittest assertions in Python test modules", () => {
    const diff = makeHunkDiff("agentchattr/tests/test_api.py", [
      "         resp = client.get('/health')",
      "-        self.assertEqual(resp.status_code, 200)",
      "         self.assertIn('ok', resp.text)",
    ])
    assert.equal(findingsFor(scanDiff(diff), "removed-assertion").length, 1)
  })

  it("does not flag an assertion rewritten in place or removed from non-test code", () => {
    const rewritten = makeHunkDiff("test/cache.test.mjs", [
      '-    assert.equal(cache.get("a"), 1)',
      '+    assert.deepEqual(cache.get("a"), 1)',
    ])
    const source = makeHunkDiff("src/cache.mjs", [
      "-  assert(size >= 0)",
      "   return size",
    ])
    assert.deepEqual(scanDiff(rewritten + source).violations, [])
  })

  it("respects an allow marker left where the assertions were removed", () => {
    const diff = makeHunkDiff("test/cache.test.mjs", [
      '     cache.set("a", 1)',
      '-    assert.equal(cache.get("a"), 1)',
      "+    // btrain-allow: removed-assertion (the eviction test covers reads)",
      "   })",
    ])
    assert.deepEqual(scanDiff(diff).violations, [])
  })
})

describe("skipped-test rule", () => {
  it("flags new unconditional skips", () => {
    const lines = [
      `it.${T.skip}("drops the cache", () => {})`,
      `describe.${T.skip}("legacy flow", () => {})`,
      `test.${T.todo}("covers the retry path", () => {})`,
      `${T.xit}("reconnects", () => {})`,
      `test.${T.fixme}("flaky upload", async () => {})`,
      `test("slow path", { ${T.skip}: true }, () => {})`,
      `test("needs network", { ${T.skip}: "no network in CI" }, () => {})`,
    ]
    for (const line of lines) {
      const result = scanDiff(makeDiff("test/sample.test.mjs", [line]))
      assert.deepEqual(result.summary, { hard: 0, warn: 1 }, line)
      assert.equal(result.violations[0].rule, "skipped-test", line)
    }
  })

  it("flags skip decorators in Python test modules", () => {
    for (const line of [`${T.pytestSkip}(reason="flaky upstream")`, `${T.unittestSkip}("broken on CI")`]) {
      const result = scanDiff(makeDiff("tests/test_upload.py", [line]))
      assert.equal(findingsFor(result, "skipped-test").length, 1, line)
    }
  })

  it("does not flag conditional skips, skips in strings or comments, or non-test files", () => {
    const lines = [
      "t.skip()",
      `test("gated", { ${T.skip}: !ENABLED }, () => {})`,
      `test("gated", { ${T.skip}: ENABLED ? false : "set BTRAIN_FORMAL=1" }, () => {})`,
      `const options = { ${T.skip}: true }`,
      `${T.xit}(helper)`,
      `// it.${T.skip}("commented out", () => {})`,
      `const title = "it.${T.skip}('quoted')"`,
    ]
    assert.deepEqual(scanDiff(makeDiff("test/sample.test.mjs", lines)).violations, [])
    const python = [`${T.pytestSkip}if(sys.platform == "win32", reason="posix only")`, `${T.unittestSkip}If(IS_CI, "slow")`]
    assert.deepEqual(scanDiff(makeDiff("tests/test_upload.py", python)).violations, [])
    assert.deepEqual(scanDiff(makeDiff("src/runner.mjs", [`it.${T.skip}("not a test file", () => {})`])).violations, [])
  })

  it("does not flag an existing skip that only moved", () => {
    const diff = makeHunkDiff("test/sample.test.mjs", [
      `-it.${T.skip}("legacy", () => {})`,
      `+  it.${T.skip}("legacy", () => {})`,
    ])
    assert.deepEqual(scanDiff(diff).violations, [])
  })

  it("respects btrain-allow: skipped-test on the line or the line above", () => {
    const sameLine = makeDiff("test/sample.test.mjs", [`it.${T.skip}("upstream outage", () => {}) // btrain-allow: skipped-test`])
    const lineAbove = makeDiff("test/other.test.mjs", ["// btrain-allow: skipped-test", `it.${T.skip}("upstream outage", () => {})`])
    assert.deepEqual(scanDiff(sameLine + lineAbove).violations, [])
  })
})

describe("focused-test rule", () => {
  it("flags new focused tests as hard violations", () => {
    const lines = [
      `it.${T.only}("debug me", () => {})`,
      `describe.${T.only}("suite", () => {})`,
      `test.describe.${T.only}("playwright suite", () => {})`,
      `${T.fit}("jasmine focus", () => {})`,
      `${T.fdescribe}("jasmine suite", () => {})`,
      `test("node focus", { ${T.only}: true }, () => {})`,
    ]
    for (const line of lines) {
      const result = scanDiff(makeDiff("test/sample.test.mjs", [line]))
      assert.deepEqual(result.summary, { hard: 1, warn: 0 }, line)
      assert.equal(result.violations[0].rule, "focused-test", line)
      assert.equal(result.violations[0].severity, "hard", line)
    }
  })

  it("does not flag look-alikes or non-test files", () => {
    const lines = [
      `model.${T.fit}(features, labels)`,
      `function ${T.fit}(points) { return points }`,
      `const flags = { ${T.only}: true }`,
      `const criteria = { ${T.only}: "one option" }`,
    ]
    assert.deepEqual(scanDiff(makeDiff("test/sample.test.mjs", lines)).violations, [])
    const python = [`def ${T.fit}(data):`, `    ${T.fit}(model, data)`]
    assert.deepEqual(scanDiff(makeDiff("tests/test_model.py", python)).violations, [])
    assert.deepEqual(scanDiff(makeDiff("src/runner.mjs", [`it.${T.only}("x", () => {})`])).violations, [])
  })

  it("respects btrain-allow: focused-test", () => {
    const diff = makeDiff("test/sample.test.mjs", [`it.${T.only}("x", () => {}) // btrain-allow: focused-test`])
    assert.deepEqual(scanDiff(diff).summary, { hard: 0, warn: 0 })
  })
})

describe("loosened-assertion rule", () => {
  it("flags an exact count replaced by a lower bound on the same subject", () => {
    const diff = makeHunkDiff("test/decomposition_inventory.test.mjs", [
      "     const { spans, fileLines } = readFunctionSpans(core)",
      "-    assert.equal(fileLines, 10_754)",
      "-    assert.equal(spans.length, 352)",
      '     assert.equal(spans.find((f) => f.name === "runLoop").lines, 422)',
      "+    assert.ok(spans.length >= 352, `expected at least 352 functions, got ${spans.length}`)",
      "+    const inFunctions = spans.reduce((a, f) => a + f.lines, 0)",
      '+    assert.ok(inFunctions < fileLines, "function lines cannot exceed the file")',
    ], { oldStart: 100, newStart: 100 })
    const findings = findingsFor(scanDiff(diff), "loosened-assertion")
    assert.equal(findings.length, 1)
    assert.equal(findings[0].line, 102)
    assert.match(findings[0].detail, /spans\.length/)
  })

  it("flags toBe replaced by toBeTruthy", () => {
    const diff = makeHunkDiff("src/counter.test.ts", [
      "-    expect(counter.value).toBe(3)",
      "+    expect(counter.value).toBeTruthy()",
    ])
    const [finding] = findingsFor(scanDiff(diff), "loosened-assertion")
    assert.equal(finding.line, 1)
    assert.match(finding.detail, /toBe\b.*toBeTruthy/)
  })

  it("flags == replaced by >= in a Python assert", () => {
    const diff = makeHunkDiff("tests/test_totals.py", [
      "-    assert total == 5",
      "+    assert total >= 5",
    ])
    assert.equal(findingsFor(scanDiff(diff), "loosened-assertion").length, 1)
  })

  it("flags a throws, rejects or raises check that loses its error matcher", () => {
    const single = makeHunkDiff("test/parse.test.mjs", [
      '-    assert.throws(() => parse(""), /empty input/)',
      '+    assert.throws(() => parse(""))',
    ])
    const multiLine = makeHunkDiff("test/trace.test.mjs", [
      "     await assert.rejects(",
      '       () => showTrace({ repoRoot, id: "xyz" }),',
      "-      /Could not dispatch/,",
      "     )",
    ], { oldStart: 20, newStart: 20 })
    const pytest = makeHunkDiff("tests/test_parse.py", [
      '-    with pytest.raises(ValueError, match="empty input"):',
      "+    with pytest.raises(ValueError):",
    ])
    const result = scanDiff(single + multiLine + pytest)
    assert.deepEqual(
      findingsFor(result, "loosened-assertion").map((finding) => [finding.file, finding.line]),
      [["test/parse.test.mjs", 1], ["test/trace.test.mjs", 20], ["tests/test_parse.py", 1]],
    )
  })

  it("does not flag a changed subject, a strict-to-strict rewrite, or a strict check kept beside a new loose one", () => {
    const changedSubject = makeHunkDiff("test/decomposition_inventory.test.mjs", [
      '-    assert.deepEqual(calls.get("renderPreCommitHook"), [1955])',
      '+    assert.equal(calls.get("renderPreCommitHook").length, 1)',
    ])
    const strictToStrict = makeHunkDiff("test/cache.test.mjs", [
      "-    assert.equal(cache.size, 1)",
      "+    assert.deepStrictEqual(cache.size, 1)",
    ])
    const keptStrict = makeHunkDiff("test/count.test.mjs", [
      "-    assert.equal(result.count, 3)",
      "+    assert.equal(result.count, 4)",
      "+    assert.ok(result.count > 0)",
    ])
    assert.deepEqual(findingsFor(scanDiff(changedSubject + strictToStrict + keptStrict), "loosened-assertion"), [])
  })

  it("respects btrain-allow: loosened-assertion", () => {
    const diff = makeHunkDiff("src/counter.test.ts", [
      "-    expect(counter.value).toBe(3)",
      "+    expect(counter.value).toBeTruthy() // btrain-allow: loosened-assertion",
    ])
    assert.deepEqual(scanDiff(diff).violations, [])
  })
})

describe("lowered-threshold rule", () => {
  it("flags lowered run counts and coverage floors", () => {
    const diffs = [
      makeHunkDiff("test/formal/props.test.mjs", ["-      { numRuns: 200, seed },", "+      { numRuns: 50, seed },"]),
      makeHunkDiff("tests/test_props.py", ["-@settings(max_examples=500)", "+@settings(max_examples=50)"]),
      makeHunkDiff("pyproject.toml", [" [tool.coverage.report]", "-fail_under = 90", "+fail_under = 80"]),
      makeHunkDiff("jest.config.js", ["   coverageThreshold: {", "     global: {", "-      branches: 80,", "+      branches: 70,"]),
      makeHunkDiff("package.json", [
        '-    "test": "c8 --check-coverage --lines 90 node --test",',
        '+    "test": "c8 --check-coverage --lines 85 node --test",',
      ]),
    ]
    for (const diff of diffs) {
      assert.equal(findingsFor(scanDiff(diff), "lowered-threshold").length, 1, diff)
    }
  })

  it("flags a lowered lower bound or a raised upper bound in an assertion", () => {
    const diffs = [
      makeHunkDiff("test/search.test.mjs", ["-    assert.ok(results.length >= 10)", "+    assert.ok(results.length >= 5)"]),
      makeHunkDiff("test/perf.test.mjs", [
        "-    assert.ok(elapsedMs <= 100, `took ${elapsedMs}ms`)",
        "+    assert.ok(elapsedMs <= 500, `took ${elapsedMs}ms`)",
      ]),
      makeHunkDiff("src/search.test.ts", ["-    expect(hits).toBeGreaterThanOrEqual(10)", "+    expect(hits).toBeGreaterThanOrEqual(3)"]),
      makeHunkDiff("tests/test_search.py", ["-        self.assertGreaterEqual(len(hits), 10)", "+        self.assertGreaterEqual(len(hits), 3)"]),
    ]
    for (const diff of diffs) {
      assert.equal(findingsFor(scanDiff(diff), "lowered-threshold").length, 1, diff)
    }
  })

  it("flags a raised retry count in tests and test configuration", () => {
    const diffs = [
      makeHunkDiff("playwright.config.ts", ["-  retries: 0,", "+  retries: 2,"]),
      makeHunkDiff("test/upload.test.mjs", ["-jest.retryTimes(1)", "+jest.retryTimes(3)"]),
    ]
    for (const diff of diffs) {
      assert.equal(findingsFor(scanDiff(diff), "lowered-threshold").length, 1, diff)
    }
  })

  it("does not flag tightened thresholds, unrelated numbers, or comparisons outside tests", () => {
    const diffs = [
      makeHunkDiff("test/formal/props.test.mjs", ["-      { numRuns: 50, seed },", "+      { numRuns: 200, seed },"]),
      makeHunkDiff("test/search.test.mjs", ["-    assert.ok(results.length >= 5)", "+    assert.ok(results.length >= 10)"]),
      makeHunkDiff("playwright.config.ts", ["-  retries: 2,", "+  retries: 0,"]),
      makeHunkDiff("src/retry.mjs", ["-  if (attempts >= 3) return", "+  if (attempts >= 2) return"]),
      makeHunkDiff("src/client.mjs", ["-  const client = new Client({ retries: 2 })", "+  const client = new Client({ retries: 5 })"]),
      makeHunkDiff("test/server.test.mjs", ["-const port = 3000", "+const port = 3001"]),
      makeHunkDiff("test/search.test.mjs", ["-    assert.ok(results.length >= 10)", "+    assert.ok(matches.length >= 5)"]),
      makeHunkDiff("test/format.test.mjs", ['-    assert.equal(label, "count > 5")', '+    assert.equal(label, "count > 3")']),
      makeHunkDiff("docs/testing.md", ["-Set numRuns: 200 for release runs.", "+Set numRuns: 50 for release runs."]),
    ]
    for (const diff of diffs) {
      assert.deepEqual(findingsFor(scanDiff(diff), "lowered-threshold"), [], diff)
    }
  })

  it("respects btrain-allow: lowered-threshold on the line or the line above", () => {
    const sameLine = makeHunkDiff("test/formal/props.test.mjs", [
      "-      { numRuns: 200, seed },",
      "+      { numRuns: 50, seed }, // btrain-allow: lowered-threshold",
    ])
    const lineAbove = makeHunkDiff("test/formal/other.test.mjs", [
      "-      { numRuns: 200, seed },",
      "+      // btrain-allow: lowered-threshold (nightly job keeps 200)",
      "+      { numRuns: 50, seed },",
    ])
    assert.deepEqual(scanDiff(sameLine + lineAbove).violations, [])
  })
})

describe("test-ignore-added rule", () => {
  it("flags a new entry in an existing ignore list", () => {
    const diff = makeHunkDiff("jest.config.js", [
      " module.exports = {",
      "   testPathIgnorePatterns: [",
      '     "/node_modules/",',
      '+    "/test/flaky/",',
      "   ],",
    ])
    const [finding, ...rest] = findingsFor(scanDiff(diff), "test-ignore-added")
    assert.equal(rest.length, 0)
    assert.equal(finding.severity, "warn")
    assert.equal(finding.line, 4)
    assert.match(finding.detail, /testPathIgnorePatterns/)
  })

  it("uses the file contents to find a list opened above the hunk", () => {
    const content = [
      "const CANDIDATE_REASON_LABELS = new Map([",
      '  ["rescope-requires-owner", "rescope-authorization"],',
      '  ["rescope-from-invalid-status", "rescope-authorization"],',
      '  ["repair-rescope-requires-guardian", "rescope-authorization"],',
      '  ["resync-requires-owner", "rescope-authorization"],',
      "  // spec 015 row 20 (Q8): accepted with an L10 record.",
      '  ["reassign-from-invalid-status", "reassign-authorization"],',
      '  ["repair-resolve-before-escalation", "repair-resolve-before-escalation"],',
      "])",
    ].join("\n")
    const diff = makeHunkDiff("test/formal/harness.test.mjs", [
      '   ["rescope-requires-owner", "rescope-authorization"],',
      '   ["rescope-from-invalid-status", "rescope-authorization"],',
      '   ["repair-rescope-requires-guardian", "rescope-authorization"],',
      '+  ["resync-requires-owner", "rescope-authorization"],',
      "+  // spec 015 row 20 (Q8): accepted with an L10 record.",
      '+  ["reassign-from-invalid-status", "reassign-authorization"],',
      '   ["repair-resolve-before-escalation", "repair-resolve-before-escalation"],',
      " ])",
    ], { oldStart: 2, newStart: 2 })
    const fileContentsByPath = { "test/formal/harness.test.mjs": content }
    const ignoreListKeys = ["CANDIDATE_REASON_LABELS"]
    assert.deepEqual(findingsFor(scanDiff(diff, { ignoreListKeys }), "test-ignore-added"), [])
    // btrain's own list names are configuration, not built-in defaults.
    assert.deepEqual(findingsFor(scanDiff(diff, { fileContentsByPath }), "test-ignore-added"), [])
    const withContents = scanDiff(diff, { fileContentsByPath, ignoreListKeys })
    assert.deepEqual(findingsFor(withContents, "test-ignore-added").map((finding) => finding.line), [5, 7])
  })

  it("flags a single-line list that grows and an append to an existing list", () => {
    const grown = makeHunkDiff("conftest.py", [
      '-collect_ignore = ["setup.py"]',
      '+collect_ignore = ["setup.py", "legacy/test_old.py"]',
    ])
    const appended = makeHunkDiff("tests/conftest.py", [
      ' collect_ignore = ["setup.py"]',
      "+if sys.version_info[0] > 2:",
      '+    collect_ignore.append("pkg/module_py2.py")',
    ])
    const result = scanDiff(grown + appended)
    assert.deepEqual(
      findingsFor(result, "test-ignore-added").map((finding) => [finding.file, finding.line]),
      [["conftest.py", 1], ["tests/conftest.py", 3]],
    )
  })

  it("reads extra ignore-list keys from options", () => {
    const diff = makeHunkDiff("test/flaky.test.mjs", [
      " const FLAKY_TESTS = [",
      '   "upload retries",',
      '+  "websocket reconnect",',
      " ]",
    ])
    assert.deepEqual(findingsFor(scanDiff(diff), "test-ignore-added"), [])
    assert.equal(findingsFor(scanDiff(diff, { ignoreListKeys: ["FLAKY_TESTS"] }), "test-ignore-added").length, 1)
  })

  it("flags exclude entries in test runner config", () => {
    const diff = makeHunkDiff("vitest.config.ts", [
      "   test: {",
      "     exclude: [",
      '       "node_modules",',
      '+      "test/e2e/**",',
      "     ],",
    ])
    assert.equal(findingsFor(scanDiff(diff), "test-ignore-added").length, 1)
  })

  it("flags a new --deselect or --test-skip-pattern in a test command", () => {
    const script = makeHunkDiff("package.json", [
      '   "scripts": {',
      "-    \"test\": \"node --test 'test/**/*.test.mjs'\",",
      "+    \"test\": \"node --test --test-skip-pattern=jev 'test/**/*.test.mjs'\",",
      "   },",
    ])
    const addopts = makeHunkDiff("pyproject.toml", [
      " addopts = [",
      '     "-ra",',
      '+    "--deselect", "tests/test_api.py::test_timeout",',
      " ]",
    ])
    const result = scanDiff(script + addopts)
    assert.deepEqual(
      findingsFor(result, "test-ignore-added").map((finding) => [finding.file, finding.line]),
      [["package.json", 2], ["pyproject.toml", 3]],
    )
  })

  it("does not flag new lists, moved entries, keys in comments, or exclude lists outside test config", () => {
    const newList = makeDiff("jest.config.js", ["module.exports = {", '  testPathIgnorePatterns: ["/node_modules/", "/legacy/"],', "}"])
    const moved = makeHunkDiff("jest.config.js", [
      "   testPathIgnorePatterns: [",
      '-    "/legacy/",',
      '     "/node_modules/",',
      '+    "/legacy/",',
      "   ],",
    ])
    const commented = makeHunkDiff("src/patterns.mjs", [
      " // testPathIgnorePatterns: [ is documented in the README",
      " const patterns = [",
      '+  "/tmp/",',
      " ]",
    ])
    const sourceExclude = makeHunkDiff("src/build.mjs", [
      " const globOptions = {",
      "   exclude: [",
      '     "node_modules",',
      '+    "dist",',
      "   ],",
    ])
    const docFlag = makeHunkDiff("README.md", ["+Run `node --test --test-skip-pattern=slow` to skip slow tests."])
    const sameFlag = makeHunkDiff("package.json", [
      '-    "test": "node --test --test-skip-pattern=slow test/",',
      "+    \"test\": \"node --test --test-skip-pattern=slow 'test/**/*.test.mjs'\",",
    ])
    const result = scanDiff(newList + moved + commented + sourceExclude + docFlag + sameFlag)
    assert.deepEqual(findingsFor(result, "test-ignore-added"), [])
  })

  it("respects btrain-allow: test-ignore-added", () => {
    const diff = makeHunkDiff("jest.config.js", [
      "   testPathIgnorePatterns: [",
      '     "/node_modules/",',
      '+    "/test/flaky/", // btrain-allow: test-ignore-added',
      "   ],",
    ])
    assert.deepEqual(scanDiff(diff).violations, [])
  })
})

describe("reviewCode weakened-test rules in real git repos", () => {
  it("sees deleted and renamed-away tests whatever the local diff config says", async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), "btrain-review-code-weak-tests-"))
    try {
      await git(repo, ["init"])
      await git(repo, ["config", "user.email", "codex@example.com"])
      await git(repo, ["config", "user.name", "Codex"])
      // Each setting would break the parse or hide the rename unless reviewCode
      // passes its own diff flags.
      await git(repo, ["config", "diff.renames", "false"])
      await git(repo, ["config", "diff.noprefix", "true"])
      await git(repo, ["config", "color.ui", "always"])
      await fs.mkdir(path.join(repo, "test"), { recursive: true })
      const body = (name) => [
        'import { it } from "node:test"',
        'import assert from "node:assert/strict"',
        "",
        `it("${name} adds", () => {`,
        "  assert.equal(1 + 1, 2)",
        "})",
        "",
        `it("${name} multiplies", () => {`,
        "  assert.equal(2 * 3, 6)",
        "  assert.ok(Number.isInteger(6))",
        "})",
        "",
      ].join("\n")
      await fs.writeFile(path.join(repo, "test", "gone.test.mjs"), body("gone"))
      await fs.writeFile(path.join(repo, "test", "moved.test.mjs"), body("moved"))
      await fs.writeFile(path.join(repo, "test", "renamed.test.mjs"), body("renamed"))
      // A path containing " b/" makes the `diff --git a/… b/…` line ambiguous.
      await fs.mkdir(path.join(repo, "test", "odd b"), { recursive: true })
      await fs.writeFile(path.join(repo, "test", "odd b", "name.test.mjs"), body("odd"))
      await git(repo, ["add", "."])
      await git(repo, ["commit", "-m", "baseline"])

      await git(repo, ["rm", "-q", "test/gone.test.mjs", "test/odd b/name.test.mjs"])
      await git(repo, ["mv", "test/moved.test.mjs", "test/moved-helper.mjs"])
      await git(repo, ["mv", "test/renamed.test.mjs", "test/renamed-again.test.mjs"])
      await fs.writeFile(
        path.join(repo, "test", "renamed-again.test.mjs"),
        body("renamed").replace("  assert.ok(Number.isInteger(6))\n", ""),
      )
      await git(repo, ["add", "."])
      await git(repo, ["commit", "-m", "drop and move tests"])

      const result = await reviewCode(repo, { base: "HEAD~1", head: "HEAD" })
      assert.deepEqual(
        result.violations.map((violation) => [violation.rule, violation.file]),
        [
          ["deleted-test-file", "test/gone.test.mjs"],
          ["deleted-test-file", "test/moved.test.mjs"],
          ["deleted-test-file", "test/odd b/name.test.mjs"],
          ["removed-assertion", "test/renamed-again.test.mjs"],
        ],
      )
      assert.deepEqual(result.summary, { hard: 0, warn: 4 })
    } finally {
      await fs.rm(repo, { recursive: true, force: true })
    }
  })

  it("reads [review_code] ignore_list_keys and run_count_keys, and finds list openers above the hunk", async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), "btrain-review-code-ignore-list-"))
    try {
      await git(repo, ["init"])
      await git(repo, ["config", "user.email", "codex@example.com"])
      await git(repo, ["config", "user.name", "Codex"])
      await fs.mkdir(path.join(repo, ".btrain"), { recursive: true })
      await fs.mkdir(path.join(repo, "test"), { recursive: true })
      await fs.writeFile(
        path.join(repo, ".btrain", "project.toml"),
        [
          "[project]",
          'name = "review-code-ignore-list"',
          "",
          "[review_code]",
          'ignore_list_keys = ["FLAKY_TESTS"]',
          'run_count_keys = ["MY_FORMAL_RUNS"]',
          "",
        ].join("\n"),
      )
      const listFile = path.join(repo, "test", "flaky-list.mjs")
      const entries = ["one", "two", "three", "four", "five", "six", "seven", "eight"].map((name) => `  "${name}",`)
      const writeList = (extra) => fs.writeFile(listFile, ["export const FLAKY_TESTS = [", ...entries, ...extra, "]", ""].join("\n"))
      const runsFile = path.join(repo, "test", "formal.test.mjs")
      const writeRuns = (runs) => fs.writeFile(runsFile, `const RUNS = Number(process.env.MY_FORMAL_RUNS || ${runs})\n`)
      await writeList([])
      await writeRuns(40)
      await git(repo, ["add", "."])
      await git(repo, ["commit", "-m", "baseline"])

      await writeList(['  "nine",'])
      await writeRuns(10)
      await git(repo, ["commit", "-am", "skip another flaky test"])
      const committed = await reviewCode(repo, { base: "HEAD~1", head: "HEAD" })
      assert.deepEqual(
        committed.violations.map((violation) => [violation.rule, violation.file, violation.line]),
        [
          ["test-ignore-added", "test/flaky-list.mjs", 10],
          ["lowered-threshold", "test/formal.test.mjs", 1],
        ],
      )

      await writeList(['  "nine",', '  "ten",'])
      const worktree = await reviewCode(repo)
      assert.deepEqual(
        worktree.violations.map((violation) => [violation.rule, violation.file, violation.line]),
        [["test-ignore-added", "test/flaky-list.mjs", 11]],
      )
    } finally {
      await fs.rm(repo, { recursive: true, force: true })
    }
  })
})

describe("formatSummary file-level findings", () => {
  it("prints a file-level finding without a line number", () => {
    const result = scanDiff(makeDeletedDiff("test/cache.test.mjs", ["it('a', () => {})"]))
    const out = formatSummary(result)
    assert.match(out, /0 hard, 1 warn/)
    assert.match(out, /⚠ \[deleted-test-file\] test\/cache\.test\.mjs$/m)
  })
})

// ---- review round 1: regex safety, whole-file masking, call structure ----

const CODE_RULES_URL = new URL("../src/brain_train/review/code-rules.mjs", import.meta.url).href

describe("scan time on pathological lines", () => {
  it("scans long adversarial lines well inside a time bound", () => {
    // A child process, because a catastrophic regex blocks the event loop:
    // only a separate process can be stopped at the timeout.
    const script = `
      import { scanDiff } from ${JSON.stringify(CODE_RULES_URL)}
      const lines = [
        "const assert" + "_A".repeat(20),
        "const assert" + "_A".repeat(5000),
        "assert.".repeat(2000),
        "expect(".repeat(2000),
        "coverage".repeat(1000) + ": 80",
        "a-".repeat(5000) + "coverage: 80",
        " ".repeat(10000) + "x",
        "(/".repeat(5000),
        "{".repeat(10000),
        "it.${T.only}(".repeat(1500),
        "${T.fit}(".repeat(2000),
        "x = " + "9".repeat(10000),
        "assert.".repeat(15000),
      ]
      const hunk = lines.flatMap((line) => ["-" + line + " 1", "+" + line + " 2"])
      const header = [
        "diff --git a/test/slow.test.mjs b/test/slow.test.mjs",
        "--- a/test/slow.test.mjs",
        "+++ b/test/slow.test.mjs",
        "@@ -1," + lines.length + " +1," + lines.length + " @@",
      ]
      const started = Date.now()
      scanDiff([...header, ...hunk].join("\\n") + "\\n")
      process.stdout.write(String(Date.now() - started))
    `
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 30_000 })
    const elapsed = Number(output)
    assert.ok(elapsed < 5000, `scan took ${elapsed} ms`)
  })
})

describe("whole-file masking", () => {
  it("hides a focused test inside a template literal opened above the hunk", () => {
    const file = "test/fixtures.test.mjs"
    const content = [
      'import { it } from "node:test"',
      "const fixture = `",
      "describe('generated', () => {",
      "  it('a', () => {})",
      "  it('b', () => {})",
      "  it('c', () => {})",
      `  it.${T.only}('d', () => {})`,
      "})",
      "`",
    ].join("\n")
    const diff = makeHunkDiff(file, [
      "   it('a', () => {})",
      "   it('b', () => {})",
      "   it('c', () => {})",
      `+  it.${T.only}('d', () => {})`,
      " })",
    ], { oldStart: 4, newStart: 4 })
    assert.deepEqual(scanDiff(diff, { fileContentsByPath: { [file]: content } }).violations, [])
    // Without the file the hunk is masked on its own, so the finding is only a warning.
    const [finding, ...rest] = scanDiff(diff).violations
    assert.equal(rest.length, 0)
    assert.equal(finding.rule, "focused-test")
    assert.equal(finding.severity, "warn")
  })

  it("hides a focused test inside a doc comment opened above the hunk", () => {
    const file = "test/usage.test.mjs"
    const content = [
      "/**",
      " * Usage:",
      " *",
      " *   it('first', () => {})",
      " *   it('second', () => {})",
      ` *   it.${T.only}('focus', () => {})`,
      " */",
      "export const x = 1",
    ].join("\n")
    const diff = makeHunkDiff(file, [
      "  *",
      "  *   it('first', () => {})",
      "  *   it('second', () => {})",
      `+ *   it.${T.only}('focus', () => {})`,
      "  */",
      " export const x = 1",
    ], { oldStart: 3, newStart: 3 })
    assert.deepEqual(scanDiff(diff, { fileContentsByPath: { [file]: content } }).violations, [])
  })

  it("sees a focused test below a hunk that starts on a closing backtick", () => {
    const file = "test/after-fixture.test.mjs"
    const content = [
      'import { it } from "node:test"',
      "const fixture = `",
      "line one",
      "line two",
      "`",
      "",
      "it('keeps', () => {})",
      `it.${T.only}('focus', () => {})`,
    ].join("\n")
    const diff = makeHunkDiff(file, [" `", " ", " it('keeps', () => {})", `+it.${T.only}('focus', () => {})`], { oldStart: 5, newStart: 5 })
    const result = scanDiff(diff, { fileContentsByPath: { [file]: content } })
    assert.deepEqual(result.violations.map((v) => [v.rule, v.severity, v.line]), [["focused-test", "hard", 8]])
  })

  it("reads the base file so a removal below a closing backtick is counted", () => {
    const file = "test/doc.test.mjs"
    const base = [
      'import assert from "node:assert"',
      "const doc = `",
      "text",
      "`",
      'it("x", () => {',
      "  assert.equal(size(), 1)",
      "})",
    ].join("\n")
    const diff = makeHunkDiff(file, [" `", ' it("x", () => {', "-  assert.equal(size(), 1)", " })"], { oldStart: 4, newStart: 4 })
    const result = scanDiff(diff, { baseFileContentsByPath: { [file]: base } })
    assert.deepEqual(findingsFor(result, "removed-assertion").map((finding) => finding.line), [6])
  })
})

describe("focused-test and skipped-test call structure", () => {
  it("only counts only / skip options that are top-level arguments of a test call", () => {
    const lines = [
      `it("parses --only", () => assert.deepEqual(parse(["--only"]), { ${T.only}: true }))`,
      "assert.deepEqual(parse(argv),",
      `  { ${T.only}: true })`,
      `if (pattern.test(line)) flags.push({ ${T.only}: true })`,
      `if (pattern.test(line)) flags.push({ ${T.skip}: true })`,
    ]
    assert.deepEqual(scanDiff(makeDiff("test/cli.test.mjs", lines)).violations, [])
  })

  it("flags only / skip set on their own line of a multi-line options object", () => {
    const call = (flag) => ["test(", '  "slow path",', "  {", `    ${flag},`, "    timeout: 5_000,", "  },", "  async () => {},", ")"]
    const focused = scanDiff(makeDiff("test/slow.test.mjs", call(`${T.only}: true`)))
    assert.deepEqual(focused.violations.map((v) => [v.rule, v.severity, v.line]), [["focused-test", "hard", 4]])
    const skipped = scanDiff(makeDiff("test/slow.test.mjs", call(`${T.skip}: "needs a GPU"`)))
    assert.deepEqual(skipped.violations.map((v) => [v.rule, v.severity, v.line]), [["skipped-test", "warn", 4]])
  })

  it("needs a title and a callback, and ignores fit helpers the file defines or imports", () => {
    const lookAlikes = [
      `context.${T.only}("tenant")`,
      `suite.${T.only}("fast")`,
      `${T.fit}("linear", points)`,
      `test.${T.todo}("write the retry test")`,
    ]
    assert.deepEqual(scanDiff(makeDiff("test/curve.test.mjs", lookAlikes)).violations, [])
    const definedHelper = [`function ${T.fit}(name, build) { return build(name) }`, `${T.fit}("linear", () => model)`]
    assert.deepEqual(scanDiff(makeDiff("test/curve.test.mjs", definedHelper)).violations, [])
    const importedHelper = [`import { ${T.fit} } from "./curve-helpers.mjs"`, `${T.fit}("linear", () => model)`]
    assert.deepEqual(scanDiff(makeDiff("test/curve.test.mjs", importedHelper)).violations, [])
    const frameworkImport = [`import { ${T.fit} } from "@jest/globals"`, `${T.fit}("focus", () => {})`]
    assert.deepEqual(scanDiff(makeDiff("test/curve.test.mjs", frameworkImport)).summary, { hard: 1, warn: 0 })
  })

  it("flags each, concurrent and serial forms", () => {
    const focused = [
      `it.${T.only}.each([[1, 2]])("adds %i", (a, b) => {})`,
      `describe.${T.only}.each([["a"]])("suite %s", () => {})`,
      `test.concurrent.${T.only}("parallel", async () => {})`,
      `test.describe.serial.${T.only}("ordered", () => {})`,
      `${T.fit}.each([1])("case %i", (n) => {})`,
    ]
    for (const line of focused) {
      assert.deepEqual(scanDiff(makeDiff("test/forms.test.mjs", [line])).summary, { hard: 1, warn: 0 }, line)
    }
    const skipped = [`it.${T.skip}.each([1])("case %i", (n) => {})`, `${T.xdescribe}.each([1])("suite %i", () => {})`]
    for (const line of skipped) {
      assert.deepEqual(scanDiff(makeDiff("test/forms.test.mjs", [line])).violations.map((v) => v.rule), ["skipped-test"], line)
    }
  })
})

describe("removed-assertion across hunks", () => {
  const twoHunks = (secondAdded) => [
    "diff --git a/test/cache.test.mjs b/test/cache.test.mjs",
    "--- a/test/cache.test.mjs",
    "+++ b/test/cache.test.mjs",
    "@@ -10,4 +10,2 @@",
    '   it("reads", () => {',
    '-    assert.equal(cache.get("a"), 1)',
    '-    assert.ok(cache.has("a"))',
    "   })",
    "@@ -40,2 +38,4 @@",
    '   it("writes", () => {',
    ...secondAdded.map((line) => `+    ${line}`),
    "   })",
  ].join("\n") + "\n"

  it("does not flag assertions that moved to another hunk of the same file", () => {
    const diff = twoHunks(['assert.equal(cache.get("a"), 1)', 'assert.ok(cache.has("a"))'])
    assert.deepEqual(scanDiff(diff).violations, [])
  })

  it("still flags a hunk that loses assertions while another hunk adds different ones", () => {
    const diff = twoHunks(["assert.equal(cache.size, 1)", "assert.ok(cache.isFresh())"])
    assert.deepEqual(findingsFor(scanDiff(diff), "removed-assertion").map((finding) => finding.line), [11])
  })
})

describe("test-ignore-added reformatting and scope", () => {
  it("does not flag an ignore list reformatted between one line and many, or requoted", () => {
    const expand = makeHunkDiff("jest.config.js", [
      " module.exports = {",
      '-  testPathIgnorePatterns: ["/node_modules/", "/legacy/"],',
      "+  testPathIgnorePatterns: [",
      '+    "/node_modules/",',
      '+    "/legacy/",',
      "+  ],",
      " }",
    ])
    const collapse = makeHunkDiff("jest.config.js", [
      " module.exports = {",
      "-  testPathIgnorePatterns: [",
      '-    "/node_modules/",',
      '-    "/legacy/",',
      "-  ],",
      '+  testPathIgnorePatterns: ["/node_modules/", "/legacy/"],',
      " }",
    ])
    const requote = makeHunkDiff("jest.config.js", [
      "   testPathIgnorePatterns: [",
      "-    '/legacy/',",
      '+    "/legacy/",',
      "   ],",
    ])
    assert.deepEqual(findingsFor(scanDiff(expand + collapse + requote), "test-ignore-added"), [])
  })

  it("flags an entry added while the list is reformatted", () => {
    const diff = makeHunkDiff("jest.config.js", [
      " module.exports = {",
      '-  testPathIgnorePatterns: ["/node_modules/"],',
      "+  testPathIgnorePatterns: [",
      '+    "/node_modules/",',
      '+    "/test/flaky/",',
      "+  ],",
      " }",
    ])
    assert.deepEqual(findingsFor(scanDiff(diff), "test-ignore-added").map((finding) => finding.line), [4])
  })

  it("counts exclude in vite config only under a test or coverage key", () => {
    const optimizeDeps = makeHunkDiff("vite.config.ts", [
      " export default defineConfig({",
      "   optimizeDeps: {",
      "     exclude: [",
      '       "fsevents",',
      '+      "lightningcss",',
      "     ],",
    ])
    const testExclude = makeHunkDiff("vite.config.ts", [
      " export default defineConfig({",
      "   test: {",
      "     exclude: [",
      '       "node_modules",',
      '+      "test/e2e/**",',
      "     ],",
    ])
    assert.deepEqual(findingsFor(scanDiff(optimizeDeps), "test-ignore-added"), [])
    assert.equal(findingsFor(scanDiff(testExclude), "test-ignore-added").length, 1)
  })
})

describe("lowered-threshold defaults and scope", () => {
  it("treats a harness run-count name as configuration, not a default", () => {
    const diff = makeHunkDiff("test/formal/harness.test.mjs", [
      "-const NUM_RUNS = Number(process.env.BTRAIN_FORMAL_RUNS || 15)",
      "+const NUM_RUNS = Number(process.env.BTRAIN_FORMAL_RUNS || 5)",
    ])
    assert.deepEqual(findingsFor(scanDiff(diff), "lowered-threshold"), [])
    const configured = scanDiff(diff, { runCountKeys: ["BTRAIN_FORMAL_RUNS"] })
    assert.deepEqual(findingsFor(configured, "lowered-threshold").map((finding) => finding.detail), ["BTRAIN_FORMAL_RUNS lowered from 15 to 5."])
  })

  it("does not flag coverage-named numbers in source or retries of a client under test", () => {
    const diffs = [
      makeHunkDiff("src/metrics.mjs", ["-const coverageTarget = 80", "+const coverageTarget = 70"]),
      makeHunkDiff("test/client.test.mjs", ["-  const client = new Client({ retries: 2 })", "+  const client = new Client({ retries: 5 })"]),
    ]
    for (const diff of diffs) {
      assert.deepEqual(findingsFor(scanDiff(diff), "lowered-threshold"), [], diff)
    }
  })

  it("flags runner retries (vitest retry, test options) and coverage floors in CI", () => {
    const diffs = [
      makeHunkDiff("vitest.config.ts", ["   test: {", "-    retry: 0,", "+    retry: 3,"]),
      makeHunkDiff("test/upload.test.mjs", ['-test("upload", { retry: 1 }, async () => {})', '+test("upload", { retry: 3 }, async () => {})']),
      makeHunkDiff(".github/workflows/ci.yml", ["-      - run: pytest --cov-fail-under=90", "+      - run: pytest --cov-fail-under=80"]),
    ]
    for (const diff of diffs) {
      assert.equal(findingsFor(scanDiff(diff), "lowered-threshold").length, 1, diff)
    }
  })
})

describe("parseUnifiedDiff paths containing ' b/'", () => {
  it("takes paths from the ---/+++ headers and strips git's trailing tab", () => {
    const diff = [
      "diff --git a/test/a b/c.test.mjs b/test/a b/c.test.mjs",
      "index 1111111..2222222 100644",
      "--- a/test/a b/c.test.mjs\t",
      "+++ b/test/a b/c.test.mjs\t",
      "@@ -1,1 +1,1 @@",
      "-old",
      "+new",
      "diff --git a/test/x b/y.test.mjs b/test/x b/y.test.mjs",
      "deleted file mode 100644",
      "index 3333333..0000000",
      "--- a/test/x b/y.test.mjs\t",
      "+++ /dev/null",
      "@@ -1,1 +0,0 @@",
      "-gone",
    ].join("\n")
    assert.deepEqual(
      parseUnifiedDiff(`${diff}\n`).map(({ file, oldFile, status }) => [file, oldFile, status]),
      [
        ["test/a b/c.test.mjs", "test/a b/c.test.mjs", "modified"],
        ["test/x b/y.test.mjs", "test/x b/y.test.mjs", "deleted"],
      ],
    )
  })
})

describe("reviewCode masks whole test files in a commit range", () => {
  it("ignores a focused test added inside a fixture string and flags a real one", async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), "btrain-review-code-masking-"))
    try {
      await git(repo, ["init"])
      await git(repo, ["config", "user.email", "codex@example.com"])
      await git(repo, ["config", "user.name", "Codex"])
      await fs.mkdir(path.join(repo, "test"), { recursive: true })
      const file = path.join(repo, "test", "fixture.test.mjs")
      const fixture = ["  it('a', () => {})", "  it('b', () => {})", "  it('c', () => {})", "  it('d', () => {})"]
      const write = (inside, after) => fs.writeFile(file, [
        'import { it } from "node:test"',
        "const fixture = `",
        "describe('generated', () => {",
        ...fixture,
        ...inside,
        "})",
        "`",
        "",
        "it('real', () => {})",
        ...after,
        "",
      ].join("\n"))
      await write([], [])
      await git(repo, ["add", "."])
      await git(repo, ["commit", "-m", "baseline"])

      await write([`  it.${T.only}('e', () => {})`], [])
      await git(repo, ["commit", "-am", "extend the fixture"])
      const insideString = await reviewCode(repo, { base: "HEAD~1", head: "HEAD" })
      assert.deepEqual(insideString.violations, [])

      await write([`  it.${T.only}('e', () => {})`], [`it.${T.only}('focus', () => {})`])
      await git(repo, ["commit", "-am", "focus a real test"])
      const realFocus = await reviewCode(repo, { base: "HEAD~1", head: "HEAD" })
      assert.deepEqual(realFocus.violations.map((v) => [v.rule, v.severity, v.line]), [["focused-test", "hard", 13]])
    } finally {
      await fs.rm(repo, { recursive: true, force: true })
    }
  })
})

// ---- review round 2: masking drift, non-literal callbacks, CRLF, packed lines ----

describe("regex literal detection in the masker", () => {
  it("does not start a regex after < or a postfix ++ / --, so later templates keep their state", () => {
    const leads = [
      "render(<p>Hi</p>); expect(getByText(`a/b`))",
      "const half = i++ / 2; const route = `a/b`",
      "const half = i-- / 2; const route = `a/b`",
    ]
    for (const lead of leads) {
      const lines = [
        'import { it } from "node:test"',
        lead,
        "const fixture = `",
        `  it.${T.only}("inside the fixture", () => {})`,
        "`",
        `it.${T.only}("real", () => {})`,
      ]
      const result = scanDiff(makeDiff("test/jsx.test.mjs", lines))
      assert.deepEqual(result.violations.map((v) => [v.rule, v.severity, v.line]), [["focused-test", "hard", 6]], lead)
    }
  })
})

describe("focus and skip calls with non-literal callbacks", () => {
  it("flags it / test / describe with a string title and any second argument", () => {
    const focused = [
      `it.${T.only}("uses a named case", runCase)`,
      `it.${T.only}("wraps the callback", withDb(async () => {}))`,
      `test.${T.only}("typed callback", async (): Promise<void> => {})`,
      `describe.${T.only}(SomeSuite.name, () => {})`,
    ]
    for (const line of focused) {
      assert.deepEqual(scanDiff(makeDiff("test/cases.test.ts", [line])).summary, { hard: 1, warn: 0 }, line)
    }
    const skipped = scanDiff(makeDiff("test/cases.test.ts", [`describe.${T.skip}("shared suite", sharedSuite)`]))
    assert.deepEqual(skipped.violations.map((v) => v.rule), ["skipped-test"])
  })

  it("still needs a literal callback for look-alike receivers, and keeps conditional skips out", () => {
    const lines = [
      `context.${T.only}("tenant", runCase)`,
      `suite.${T.only}("fast", runCase)`,
      `${T.fit}("linear", fitPoints)`,
      `test.${T.skip}(isMobile, "no touch support")`,
      `test.${T.skip}(browserName === "webkit", "flaky on webkit")`,
    ]
    assert.deepEqual(scanDiff(makeDiff("test/cases.test.ts", lines)).violations, [])
  })
})

describe("reviewCode on a CRLF checkout", () => {
  it("keeps focused-test hard in worktree mode when the file on disk uses CRLF", async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), "btrain-review-code-crlf-"))
    try {
      await git(repo, ["init"])
      await git(repo, ["config", "user.email", "codex@example.com"])
      await git(repo, ["config", "user.name", "Codex"])
      await fs.writeFile(path.join(repo, ".gitattributes"), "*.mjs text eol=crlf\n")
      await fs.mkdir(path.join(repo, "test"), { recursive: true })
      const file = path.join(repo, "test", "crlf.test.mjs")
      const body = [
        'import { it } from "node:test"',
        "",
        "it('one', () => {})",
        "it('two', () => {})",
        "it('three', () => {})",
        "it('four', () => {})",
        "it('five', () => {})",
      ]
      await fs.writeFile(file, `${body.join("\n")}\n`)
      await git(repo, ["add", "."])
      await git(repo, ["commit", "-m", "baseline"])

      // The worktree copy carries CRLF, as a checkout with eol=crlf writes it.
      await fs.writeFile(file, `${[...body, `it.${T.only}('focus', () => {})`].join("\r\n")}\r\n`)
      const result = await reviewCode(repo, { base: "HEAD" })
      assert.deepEqual(result.violations.map((v) => [v.rule, v.severity, v.line]), [["focused-test", "hard", 8]])
    } finally {
      await fs.rm(repo, { recursive: true, force: true })
    }
  })
})

describe("scan time on packed lines", () => {
  it("scans lines packed with calls and imports within a time bound", () => {
    // A child process, like the pathological-line test above.
    const script = `
      import { scanDiff } from ${JSON.stringify(CODE_RULES_URL)}
      const lines = []
      for (let i = 0; i < 200; i++) lines.push("test(".repeat(990))
      for (let i = 0; i < 50; i++) lines.push("import ".repeat(700))
      for (let i = 0; i < 50; i++) lines.push('it.${T.only}("x", '.repeat(300))
      lines.push('${T.fit}("focus", () => {})')
      const file = "test/packed.test.mjs"
      const diff = [
        "diff --git a/" + file + " b/" + file,
        "--- a/" + file,
        "+++ b/" + file,
        "@@ -0,0 +1," + lines.length + " @@",
        ...lines.map((line) => "+" + line),
      ].join("\\n") + "\\n"
      const started = Date.now()
      scanDiff(diff, { fileContentsByPath: { [file]: lines.join("\\n") } })
      process.stdout.write(String(Date.now() - started))
    `
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 120_000 })
    const elapsed = Number(output)
    assert.ok(elapsed < 3000, `scan took ${elapsed} ms`)
  })
})

// ---- review round 3: argument heads, JSX, literal titles, surviving mutants ----

// Four comment lines, about 300 characters, between two arguments.
const LONG_COMMENT = [
  "    // Covers the regression from the tracker where the parser dropped the",
  "    // trailing comma. It stays on its own because it needs a fresh fixture",
  "    // and the setup is slow, so please do not fold it into the list test.",
  "    // See the linked issue for the reproduction and the chosen fix.",
]

describe("argument heads after long comments", () => {
  it("still sees a callback, an options object or an only: property after a long comment", () => {
    const callback = [`it.${T.only}(`, '  "handles the edge case",', ...LONG_COMMENT, "  async () => {},", ")"]
    const optionsObject = ["test(", '  "slow path",', ...LONG_COMMENT, `  { ${T.only}: true },`, "  async () => {},", ")"]
    const property = ["test(", '  "slow path",', "  {", ...LONG_COMMENT, `    ${T.only}: true,`, "  },", "  async () => {},", ")"]
    for (const [name, lines, line] of [["callback", callback, 1], ["options object", optionsObject, 7], ["property", property, 8]]) {
      const result = scanDiff(makeDiff("test/comments.test.mjs", lines))
      assert.deepEqual(result.violations.map((v) => [v.rule, v.severity, v.line]), [["focused-test", "hard", line]], name)
    }
  })
})

describe("options objects with many properties", () => {
  it("reads every property of an options object, not just the first few", () => {
    const line = `test("x", { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, ${T.only}: true }, () => {})`
    assert.deepEqual(scanDiff(makeDiff("test/props.test.mjs", [line])).summary, { hard: 1, warn: 0 })
  })

  it("puts a property that starts a line on that line", () => {
    const lines = ['test("x", {', `${T.only}: true,`, "}, () => {})"]
    const result = scanDiff(makeDiff("test/props.test.mjs", lines))
    assert.deepEqual(result.violations.map((v) => [v.rule, v.line]), [["focused-test", 2]])
  })
})

describe("regex literals after a spaced < or <<", () => {
  it("still starts a regex after a comparison or shift with a space before the slash", () => {
    const leads = ["const ok = a < /`/.test(s)", "const v = a << /`/.lastIndex", "const ok = a <= /`/.test(s)"]
    for (const lead of leads) {
      const lines = [
        'import { it } from "node:test"',
        lead,
        "const fixture = `",
        `  it.${T.only}("inside the fixture", () => {})`,
        "`",
        `it.${T.only}("real", () => {})`,
      ]
      const result = scanDiff(makeDiff("test/compare.test.mjs", lines))
      assert.deepEqual(result.violations.map((v) => [v.rule, v.severity, v.line]), [["focused-test", "hard", 6]], lead)
    }
  })
})

describe("JSX self-closing tags in the masker", () => {
  it("does not start a regex at /> after an expression container", () => {
    const leads = [
      "render(<Link to={route} />); expect(href).toBe(`/home`)",
      "render(<Link to={route}/>); expect(href).toBe(`/home`)",
      "render(<Foo {...props} />); expect(url).toBe(`/a`)",
    ]
    for (const lead of leads) {
      const lines = [
        'import { it } from "node:test"',
        lead,
        "const fixture = `",
        `  it.${T.only}("inside the fixture", () => {})`,
        "`",
        `it.${T.only}("real", () => {})`,
      ]
      const result = scanDiff(makeDiff("test/link.test.tsx", lines))
      assert.deepEqual(result.violations.map((v) => [v.rule, v.severity, v.line]), [["focused-test", "hard", 6]], lead)
    }
  })
})

describe("title arguments", () => {
  it("needs the whole first argument to be a string or template literal", () => {
    const lines = [
      `test.${T.skip}("webkit" === browserName, "flaky on webkit")`,
      `test.${T.skip}(\`\${browser}\` === "webkit", "flaky on webkit")`,
    ]
    assert.deepEqual(scanDiff(makeDiff("test/browser.test.ts", lines)).violations, [])
    const titled = scanDiff(makeDiff("test/browser.test.ts", [`test.${T.skip}(\`slow on \${browser}\`, runCase)`]))
    assert.deepEqual(titled.violations.map((v) => v.rule), ["skipped-test"])
  })
})

describe("mutation guards", () => {
  it("accepts a TypeScript return type on a look-alike receiver's callback", () => {
    const line = `context.${T.only}("typed", async (): Promise<void> => {})`
    assert.deepEqual(scanDiff(makeDiff("test/typed.test.ts", [line])).summary, { hard: 1, warn: 0 })
  })

  it("treats fdescribe, xdescribe and xtest as title receivers", () => {
    const focused = scanDiff(makeDiff("test/suites.test.mjs", [`${T.fdescribe}("suite", sharedSuite)`]))
    assert.deepEqual(focused.summary, { hard: 1, warn: 0 })
    for (const line of [`${T.xdescribe}("suite", sharedSuite)`, `x${"test"}("case", runCase)`]) {
      assert.deepEqual(scanDiff(makeDiff("test/suites.test.mjs", [line])).violations.map((v) => v.rule), ["skipped-test"], line)
    }
  })

  it("keeps the callback of a call whose body runs past the hunk", () => {
    const diff = makeHunkDiff("test/top.test.mjs", [
      ' import { it } from "node:test"',
      '-it("x", () => {',
      `+it.${T.only}("x", () => {`,
      "   const a = 1",
      "   const b = 2",
      "   const c = 3",
    ])
    assert.deepEqual(scanDiff(diff).violations.map((v) => [v.rule, v.severity, v.line]), [["focused-test", "hard", 2]])
  })

  it("reads a test call's title, options and callback, and nothing after them", () => {
    const threeArguments = scanDiff(makeDiff("test/suite.test.mjs", [`suite.${T.only}("fast", { timeout: 100 }, () => {})`]))
    assert.deepEqual(threeArguments.summary, { hard: 1, warn: 0 })
    // No framework takes a test body as its fourth argument.
    const fourArguments = scanDiff(makeDiff("test/suite.test.mjs", [`suite.${T.only}("fast", first, second, () => {})`]))
    assert.deepEqual(fourArguments.violations, [])
  })

  it("counts an ignore-list entry that is added twice but was there once", () => {
    const listed = makeHunkDiff("jest.config.js", [
      " module.exports = {",
      '-  testPathIgnorePatterns: ["/legacy/"],',
      "+  testPathIgnorePatterns: [",
      '+    "/legacy/",',
      '+    "/legacy/",',
      "+  ],",
      " }",
    ])
    assert.deepEqual(findingsFor(scanDiff(listed), "test-ignore-added").map((finding) => finding.line), [4])
    const appended = makeHunkDiff("conftest.py", [
      ' collect_ignore = ["setup.py"]',
      '-collect_ignore.append("legacy.py")',
      '+collect_ignore.append("legacy.py")',
      '+collect_ignore.append("legacy.py")',
    ])
    assert.deepEqual(findingsFor(scanDiff(appended), "test-ignore-added").map((finding) => finding.line), [3])
  })
})

describe("scan time on nested typed callbacks and packed imports", () => {
  const timeScan = (body) => {
    const script = `
      import { scanDiff } from ${JSON.stringify(CODE_RULES_URL)}
      const lines = []
      ${body}
      const file = "test/packed.test.mjs"
      const diff = [
        "diff --git a/" + file + " b/" + file,
        "--- a/" + file,
        "+++ b/" + file,
        "@@ -0,0 +1," + lines.length + " @@",
        ...lines.map((line) => "+" + line),
      ].join("\\n") + "\\n"
      const started = Date.now()
      scanDiff(diff, { fileContentsByPath: { [file]: lines.join("\\n") } })
      process.stdout.write(String(Date.now() - started))
    `
    return Number(execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 120_000 }))
  }

  it("reads only the head of each argument", () => {
    // Each second argument starts a typed arrow with no "=" after it, so an
    // unbounded head would run the callback pattern to the end of the line.
    const elapsed = timeScan(`for (let i = 0; i < 300; i++) lines.push('context.${T.only}("x", (): '.repeat(200))`)
    assert.ok(elapsed < 3000, `scan took ${elapsed} ms`)
  })

  it("scans packed import lines behind a fit call", () => {
    const elapsed = timeScan(`
      for (let i = 0; i < 100; i++) lines.push("import ".repeat(700))
      lines.push('${T.fit}("focus", () => {})')
    `)
    assert.ok(elapsed < 3000, `scan took ${elapsed} ms`)
  })
})

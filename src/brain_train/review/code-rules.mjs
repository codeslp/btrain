// code-rules.mjs — `btrain review code` deterministic rule scanner.
//
// Scans the lane's diff for known anti-patterns and emits a structured
// violation list. Pure regex / heuristic — no LLM, no AST, no new deps.
//
// Rules:
//   hardcoded-secret    (hard)  — known API key formats in added lines
// btrain-allow: cors-wildcard
//   cors-wildcard       (hard)  — Access-Control-Allow-Origin: *
//   unprotected-route   (warn)  — new HTTP route handler with no
//                                 helmet/security-header import in the file
//   env-var-required    (warn)  — long literal assigned to *_KEY/*_TOKEN/
//                                 *_SECRET that isn't derived from env
//   new-dependency      (warn)  — added line in package.json deps,
//                                 requirements.txt, pyproject.toml, Cargo.toml
//
// Weakened-test rules. These also read removed lines and file headers, and
// scan code with string, regex and comment contents masked out. Masking runs
// over whole files when their contents are loaded (reviewCode loads them);
// otherwise each hunk is masked on its own.
//   deleted-test-file   (warn)  — test file deleted, or renamed to a
//                                 non-test path
//   removed-assertion   (warn)  — a hunk of a surviving test file removes
//                                 more assertion lines than it adds, after
//                                 lines that moved within the file cancel out
//   skipped-test        (warn)  — new unconditional skip, todo or fixme
//   focused-test        (hard)  — new focused test (only / fit / fdescribe);
//                                 warn when the file was masked hunk by hunk
//   loosened-assertion  (warn)  — in one hunk, a strict check on a subject is
//                                 replaced by a looser check on that subject
//   lowered-threshold   (warn)  — otherwise identical lines where a run
//                                 count, coverage floor or lower bound drops,
//                                 or a runner retry count or upper bound rises
//   test-ignore-added   (warn)  — new entry in an existing test ignore list,
//                                 or a new --deselect / --test-skip-pattern
//
// Config, in `[review_code]` of .btrain/project.toml (single-line arrays):
//   ignore_list_keys = ["NAME"]  more test-ignore-added list names
//   run_count_keys = ["NAME"]    more lowered-threshold run-count names
//
// Per-line allow markers suppress violations for that rule on that line:
//   // btrain-allow: hardcoded-secret
//   # btrain-allow: cors-wildcard
// Markers may appear at end of the violating line or on the line above.
// A finding about removed lines sits on the new-file line where the removal
// happened, so the marker goes there (or on the line above it).

import { execFile, spawn } from "node:child_process"
import fs from "node:fs/promises"
import { promisify } from "node:util"
import path from "node:path"
import {
  BtrainError,
  getLaneConfigs,
  readAllLaneStates,
  readLockRegistry,
  readProjectConfig,
} from "../core.mjs"

const execFileAsync = promisify(execFile)

const DIFF_MAX_BUFFER = 32 * 1024 * 1024

// ---- secret patterns ----
// Each entry: { id, regex, label }. The regex matches a key inside a longer
// line; we only flag added (`+`) diff lines.
const SECRET_PATTERNS = [
  { id: "aws-access-key-id", regex: /\bAKIA[0-9A-Z]{16}\b/, label: "AWS access key ID" },
  { id: "github-token", regex: /\bgh[pousr]_[A-Za-z0-9_]{36,}\b/, label: "GitHub token" },
  { id: "stripe-key", regex: /\bsk_(?:live|test)_[A-Za-z0-9]{24,}\b/, label: "Stripe key" },
  { id: "openai-key", regex: /\bsk-[A-Za-z0-9]{40,}\b/, label: "OpenAI-style key" },
  { id: "anthropic-key", regex: /\bsk-ant-[A-Za-z0-9_-]{32,}\b/, label: "Anthropic key" },
  { id: "slack-token", regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, label: "Slack token" },
  { id: "bearer-token", regex: /\b[Bb]earer\s+[A-Za-z0-9._-]{20,}\b/, label: "Bearer token" },
]

const CORS_WILDCARD_PATTERNS = [
  // btrain-allow: cors-wildcard
  // Header literal: Access-Control-Allow-Origin: *
  /Access-Control-Allow-Origin\s*:\s*['"`]?\*['"`]?/i,
  // btrain-allow: cors-wildcard
  // setHeader / set call: ('Access-Control-Allow-Origin', '*')
  /['"`]Access-Control-Allow-Origin['"`]\s*,\s*['"`]\*['"`]/i,
  // btrain-allow: cors-wildcard
  // JS object form: { origin: "*" } or origin:'*'
  /\borigin\s*:\s*['"`]\*['"`]/i,
]

// HTTP route handler patterns (Express/Koa/Fastify-ish). Excludes `.use` and
// `.all` which are middleware mounts, not endpoints — those are matched by
// downstream middleware checks (e.g., the helmet import marker).
const ROUTE_PATTERNS = [
  /\b(?:app|router|server)\.(?:get|post|put|patch|delete|options)\s*\(/,
  /\b(?:fastify|app)\.route\s*\(/,
]

const SECURITY_IMPORT_PATTERNS = [
  /\brequire\s*\(\s*['"`]helmet['"`]/,
  /\bfrom\s+['"`]helmet['"`]/,
  /\bimport\s+['"`]helmet['"`]/,
  /\b(?:setHeader|set)\s*\(\s*['"`](?:Strict-Transport-Security|Content-Security-Policy|X-Frame-Options|X-Content-Type-Options)['"`]/i,
]

// env-var-required: name suggests secret, value is a long literal not from env.
const SECRET_VAR_NAME = /\b([A-Z][A-Z0-9_]*(?:_KEY|_TOKEN|_SECRET|_PASSWORD|_API_KEY))\b/
const ENV_DERIVATIONS = [
  /process\.env\b/,
  /os\.environ\b/,
  /os\.getenv\b/,
  /Deno\.env\b/,
  /import\.meta\.env\b/,
  /env\.var\b/,
]

// new-dependency: dependency manifest files and whether every added line counts.
const DEPENDENCY_FILES = [
  { name: "package.json", everyAddedLine: false },
  { name: "requirements.txt", everyAddedLine: true },
  { name: "pyproject.toml", everyAddedLine: false },
  { name: "Cargo.toml", everyAddedLine: false },
  { name: "go.mod", everyAddedLine: false },
]

// ---- weakened-test rules: file classes ----

const TEST_CODE_EXTENSION = "(?:[cm]?[jt]sx?|py|go|rb|rs|java|kts?|scala|groovy|cs|swift|php|exs?|dart)"
// Runner naming conventions: foo.test.mjs, foo.spec.ts, foo_test.go,
// foo-test.js, test_foo.py, FooTest.java, __tests__/foo.js, Rust tests/*.rs.
const TEST_BASENAME_PATTERNS = [
  new RegExp(`[._-](?:test|spec)\\.${TEST_CODE_EXTENSION}$`, "i"),
  new RegExp(`^test[_-].+\\.${TEST_CODE_EXTENSION}$`, "i"),
  /(?:Tests?|Spec|IT)\.(?:java|kts?|scala|groovy|cs|swift|php)$/,
]
const TEST_PATH_PATTERNS = [
  new RegExp(`(?:^|/)__tests__/.+\\.${TEST_CODE_EXTENSION}$`, "i"),
  /(?:^|\/)tests\/[^/]+\.rs$/,
]
const DOC_FILE = /\.(?:md|mdx|markdown|rst|txt|adoc)$/i
const PYTHON_FILE = /\.pyi?$/
// Files whose comments start with `#`; every other file uses // and /* */.
const HASH_COMMENT_FILE =
  /(?:\.(?:py|pyi|rb|sh|bash|zsh|toml|ya?ml|ini|cfg|conf|mk|r|pl)|(?:^|\/)(?:Makefile|makefile|GNUmakefile|justfile|Justfile|Dockerfile|\.coveragerc))$/
// Test-runner and coverage config. `exclude` counts only in the JS ones.
const JS_TEST_CONFIG_BASENAME =
  /^(?:(?:jest|vitest|vite|playwright|cypress|karma|wdio|ava|mocha)(?:\.[\w-]+)*\.(?:[cm]?[jt]s|json)|karma\.conf\.[cm]?js|\.(?:mocharc|nycrc|c8rc)(?:\.(?:json|ya?ml|[cm]?js))?|package\.json)$/
const PYTHON_TEST_CONFIG_BASENAME = /^(?:\.coveragerc|\.?codecov\.ya?ml|pytest\.ini|tox\.ini|setup\.cfg|pyproject\.toml|conftest\.py)$/
// Config shared with non-test tools (vite optimizeDeps, package.json
// fields). There `exclude` counts only under one of these parent keys.
const SHARED_CONFIG_BASENAME = /^(?:(?:vite|vitest)(?:\.[\w-]+)*\.(?:[cm]?[jt]s|json)|package\.json)$/
const EXCLUDE_PARENT_KEYS = new Set(["test", "coverage", "nyc", "c8", "mocha", "ava"])
// Files that carry test commands: package scripts, CI, shell, make, ini, toml.
const COMMAND_FILE =
  /(?:\.(?:ya?ml|toml|ini|cfg|sh|bash|zsh|mk)|(?:^|\/)(?:package\.json|Makefile|makefile|GNUmakefile|justfile|Justfile|Dockerfile))$/

// ---- weakened-test rules: patterns ----

// removed-assertion counts lines with assert…( / expect( / self.assert…(
// (Rust assert_eq!( included) and Python's bare `assert` statement. A single
// character class after `assert` keeps the match linear: nested groups there
// backtrack exponentially on a long identifier such as assert_A_A_A.
const ASSERTION_CALL = /(?<![\w$])(?:assert(?=[A-Z_.!(\s])[\w.]*!?\s*\(|expect(?:\.\w+)?\s*\()/
const PYTHON_ASSERT_STATEMENT = /^\s*assert\b(?!\s*\.)/

// Focus and skip calls: it.only(, describe.skip(, test.concurrent.only(,
// test.describe.serial.only(, it.only.each(, and fit( / xit( / xdescribe(
// with an optional .each. Without .each a call also needs a title and a
// callback, so context.only("tenant") or a fit("linear", points) helper is
// not one; neither is a Jest test.todo("title") placeholder.
const RUNNER_MARKER_CALL =
  /(?<![\w$.])(?:it|test|describe|suite|context|specify)(?:\.(?:concurrent|serial|parallel|sequential|describe))*\.(only|skip|todo|fixme)(\.each)?\s*[(`]/g
const PREFIXED_MARKER_CALL = /(?<![\w$.])(f(?:it|describe)|x(?:it|test|describe|context|specify))(\.each)?\s*[(`]/g
const PREFIXED_MARKER_NAMES = ["fit", "fdescribe", "xit", "xtest", "xdescribe", "xcontext", "xspecify"]
// A fit or xit that the file defines, or imports from a non-test module, is a helper.
const TEST_FRAMEWORK_MODULES = new Set(["@jest/globals", "vitest", "bun:test", "jasmine", "jasmine-core", "mocha", "@playwright/test"])
// Test calls whose top-level options object can set only, skip, todo or
// retry: test("name", { only: true }, fn). Other receivers are not test calls
// (pattern.test(x)), except node:test's `t`.
const TEST_OPTIONS_CALL = /(?<![\w$.])(?:t\.)?(?:test|it|describe|suite)\s*\(/g
const CALLBACK_ARG = /^(?:async\s+)?(?:function\b|\([^()]*\)\s*=>|[\w$]+\s*=>)/
const CALL_LOOKAHEAD_LINES = 12
// Runner-level retry settings in a test file. Anything else there named
// retries is usually the code under test.
const RUNNER_RETRY_CALL = /\bthis\.retries\s*\(|\bjest\.retryTimes\s*\(|\btest(?:\.describe)?\.configure\s*\(/

// loosened-assertion grades each assertion as strict (a specific value,
// pattern or error) or loose (truthiness, a bound, a negation) and compares
// removed and added checks on the same subject within one hunk.
const ASSERTION_START =
  /(?<![\w$])(?:self\.assert[A-Z]\w*\s*\(|assert(?:\.strict)?(?:\.\w+)?\s*\(|(?<!\.)expect\s*\(|pytest\.raises\s*\()/
const STRICT_NODE_ASSERTS = new Set(["equal", "strictEqual", "deepEqual", "deepStrictEqual", "partialDeepStrictEqual", "match"])
const LOOSE_NODE_ASSERTS = new Set(["notEqual", "notStrictEqual", "notDeepEqual", "notDeepStrictEqual"])
const STRICT_EXPECT_MATCHERS = new Set([
  "toBe", "toEqual", "toStrictEqual", "toHaveLength", "toMatch", "toMatchObject", "toMatchSnapshot",
  "toMatchInlineSnapshot", "toHaveBeenCalledWith", "toHaveBeenCalledTimes", "toHaveBeenLastCalledWith",
  "toHaveBeenNthCalledWith", "toHaveReturnedWith", "toBeNull", "toBeUndefined", "toBeNaN", "toBeCloseTo",
])
const LOOSE_EXPECT_MATCHERS = new Set([
  "toBeTruthy", "toBeFalsy", "toBeDefined", "toBeGreaterThan", "toBeGreaterThanOrEqual", "toBeLessThan",
  "toBeLessThanOrEqual", "toHaveBeenCalled", "toContain", "toContainEqual", "toBeInstanceOf",
])
const STRICT_UNITTEST_ASSERTS = new Set([
  "assertEqual", "assertEquals", "assertDictEqual", "assertListEqual", "assertTupleEqual", "assertSetEqual",
  "assertSequenceEqual", "assertMultiLineEqual", "assertCountEqual", "assertItemsEqual", "assertIs",
  "assertIsNone", "assertRegex", "assertRegexpMatches", "assertRaisesRegex", "assertRaisesRegexp",
  "assertWarnsRegex", "assertAlmostEqual",
])
const LOOSE_UNITTEST_ASSERTS = new Set([
  "assertFalse", "assertIsNotNone", "assertIsNot", "assertNotEqual", "assertNotEquals", "assertGreater",
  "assertGreaterEqual", "assertLess", "assertLessEqual", "assertRaises", "assertWarns", "assertIsInstance",
])
const COMPARISON_OPERATORS = ["===", "!==", "==", "!=", ">=", "<=", ">", "<"]
const STRICT_COMPARISONS = new Set(["===", "==", "is"])
const MAX_STATEMENT_LINES = 12

// lowered-threshold: a number attached to one of these settings (the text
// just before it matches `before`). `loosens` is the direction that weakens
// the suite. Scopes: config = test config and command files, testConfig =
// test config only, runner = test config, or a runner retry line in a test.
// Run counts (DEFAULT_RUN_COUNT_KEYS plus run_count_keys) apply in any
// non-doc file.
const NUMBER_LITERAL = /(?<![\w$.])\d[\d_]*(?:\.\d+)?(?![\w$])/g
const DEFAULT_RUN_COUNT_KEYS = ["numRuns", "max_examples"]
const THRESHOLD_SETTINGS = [
  { name: "coverage", loosens: "lowered", scope: "config", before: /[\w-]*coverage[\w-]*["']?(?:\s*[:=]\s*|\s+)["']?$/i },
  { name: "fail_under", loosens: "lowered", scope: "config", before: /fail[_-]?under["']?(?:\s*[:=]\s*|\s+)["']?$/i },
  { name: "coverage threshold", loosens: "lowered", scope: "testConfig", before: /\b(?:branches|functions|lines|statements)["']?\s*[:=]?\s*$/ },
  { name: "retries", loosens: "raised", scope: "runner", before: /\bretr(?:ies|y)["']?\s*(?:[:=(]|\s)\s*$/ },
  { name: "retryTimes", loosens: "raised", scope: "runner", before: /\bretryTimes\s*\(\s*$/ },
]
// Only this much text on each side of a number is examined, which bounds
// the polynomial regexes above on very long lines.
const THRESHOLD_WINDOW = 200
const LOWER_BOUND_CALL = /\b(?:toBeGreaterThan(?:OrEqual)?|assertGreater(?:Equal)?)\(\s*(?:[^,()]*(?:\([^()]*\)[^,()]*)?,\s*)?$/
const UPPER_BOUND_CALL = /\b(?:toBeLessThan(?:OrEqual)?|assertLess(?:Equal)?)\(\s*(?:[^,()]*(?:\([^()]*\)[^,()]*)?,\s*)?$/

// test-ignore-added list names; `[review_code] ignore_list_keys` adds more.
const DEFAULT_IGNORE_LIST_KEYS = ["testPathIgnorePatterns", "testIgnore", "exclude", "collect_ignore", "collect_ignore_glob"]
const CONFIG_KEY_NAME = /^[A-Za-z_$][\w$-]*$/
const IGNORE_FLAG = /(?:^|[\s"'`=,[(])(--deselect|--test-skip-pattern)(?![\w-])(?:=|\s+|["'`]?\s*,\s*["'`]?)?([^\s"'`,\]]*)/g

// ---- diff parsing ----

// Parse a unified diff into per-file blocks of hunk lines with line numbers.
// Returns one entry per file:
//   file     new path (the b/ side)
//   added    [{ line, text }] with new-file line numbers
//   lines    [{ line, text, kind }] added and context lines, new-file numbers
//   oldFile  old path; differs from file only for a rename
//   status   "modified" | "added" | "deleted" | "renamed"
//   removed  [{ line, text }] with old-file line numbers
//   hunks    [{ oldStart, newStart, added, removed, entries }]; entries keep
//            diff order as { kind, text, oldLine, newLine }, and a removed
//            entry's newLine is the new-file line at the removal point.
// The original rules and the allow-marker lookup read only added and lines,
// whose shape is unchanged.
export function parseUnifiedDiff(diff) {
  const files = []
  let currentFile = null
  let currentHunk = null
  let newLineNum = 0
  let oldLineNum = 0
  let inHunk = false

  for (const raw of diff.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      // start a new file
      const file = diffGitPath(raw)
      currentFile = { file, added: [], lines: [], oldFile: file, status: "modified", removed: [], hunks: [] }
      files.push(currentFile)
      currentHunk = null
      newLineNum = 0
      oldLineNum = 0
      inHunk = false
      continue
    }
    if (!currentFile) continue
    if (raw.startsWith("@@")) {
      // @@ -a,b +c,d @@  →  pull a and c
      const match = /\+(\d+)(?:,\d+)?/.exec(raw)
      if (match) newLineNum = Number.parseInt(match[1], 10)
      const oldMatch = /^@@ -(\d+)/.exec(raw)
      if (oldMatch) oldLineNum = Number.parseInt(oldMatch[1], 10)
      currentHunk = { oldStart: oldLineNum, newStart: newLineNum, added: [], removed: [], entries: [] }
      currentFile.hunks.push(currentHunk)
      inHunk = true
      continue
    }
    if (!inHunk) {
      readFileHeader(currentFile, raw)
      continue
    }
    if (raw.startsWith("\\ No newline at end of file")) continue
    if (raw.startsWith("+")) {
      const entry = { line: newLineNum, text: raw.slice(1), kind: "added" }
      currentFile.lines.push(entry)
      currentFile.added.push({ line: entry.line, text: entry.text })
      currentHunk.added.push({ line: entry.line, text: entry.text })
      currentHunk.entries.push({ kind: "added", text: entry.text, oldLine: null, newLine: entry.line })
      newLineNum++
    } else if (raw.startsWith("-")) {
      // removed; line numbers in the new file don't advance
      const text = raw.slice(1)
      currentFile.removed.push({ line: oldLineNum, text })
      currentHunk.removed.push({ line: oldLineNum, text })
      currentHunk.entries.push({ kind: "removed", text, oldLine: oldLineNum, newLine: newLineNum })
      oldLineNum++
    } else if (raw.startsWith(" ")) {
      currentFile.lines.push({ line: newLineNum, text: raw.slice(1), kind: "context" })
      currentHunk.entries.push({ kind: "context", text: raw.slice(1), oldLine: oldLineNum, newLine: newLineNum })
      newLineNum++
      oldLineNum++
    }
  }
  return files.filter((f) => f.file)
}

// The b/ path of a `diff --git a/<old> b/<new>` line. When both sides are
// the same path the split is exact even if the path contains " b/"; the
// ---/+++ and rename headers that follow correct any other case.
function diffGitPath(raw) {
  const same = /^diff --git a\/(.+) b\/\1$/.exec(raw)
  if (same) return same[1]
  const match = /\sb\/(.+)$/.exec(raw)
  if (match) return match[1]
  const quoted = /\s"b\/((?:[^"\\]|\\.)*)"$/.exec(raw)
  return quoted ? unquoteGitPath(`"${quoted[1]}"`) : ""
}

// The path in a `--- a/<path>` or `+++ b/<path>` header, or null for
// /dev/null. Git ends the header with a tab when the path has a space.
function headerPath(value, prefix) {
  const text = unquoteGitPath(value.replace(/\t$/, ""))
  if (text === "/dev/null") return null
  return text.startsWith(prefix) ? text.slice(prefix.length) : text
}

// Extended header lines between `diff --git` and the first hunk.
function readFileHeader(entry, raw) {
  if (raw.startsWith("new file mode ")) {
    entry.status = "added"
  } else if (raw.startsWith("deleted file mode ")) {
    entry.status = "deleted"
  } else if (raw.startsWith("rename from ")) {
    entry.status = "renamed"
    entry.oldFile = unquoteGitPath(raw.slice("rename from ".length))
  } else if (raw.startsWith("rename to ")) {
    entry.status = "renamed"
    entry.file = unquoteGitPath(raw.slice("rename to ".length))
  } else if (raw.startsWith("--- ")) {
    const oldPath = headerPath(raw.slice(4), "a/")
    if (oldPath === null) entry.status = "added"
    else entry.oldFile = oldPath
  } else if (raw.startsWith("+++ ")) {
    const newPath = headerPath(raw.slice(4), "b/")
    if (newPath === null) {
      entry.status = "deleted"
      entry.file = entry.oldFile
    } else {
      entry.file = newPath
    }
  }
}

// Git quotes a path with special characters C-style: "caf\303\251.mjs".
function unquoteGitPath(value) {
  if (!(value.length >= 2 && value.startsWith("\"") && value.endsWith("\""))) return value
  const escapes = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11 }
  const bytes = []
  for (const [, escape, run] of value.slice(1, -1).matchAll(/\\([0-7]{3}|.)|([^\\]+)/gsu)) {
    if (run !== undefined) bytes.push(...Buffer.from(run, "utf8"))
    else if (/^[0-7]{3}$/.test(escape)) bytes.push(Number.parseInt(escape, 8))
    else bytes.push(...(escape in escapes ? [escapes[escape]] : Buffer.from(escape, "utf8")))
  }
  return Buffer.from(bytes).toString("utf8")
}

// ---- allow markers ----

const ALLOW_RE = /(?:\/\/|#|--|\/\*)\s*btrain-allow\s*:\s*([a-z0-9-]+(?:\s*,\s*[a-z0-9-]+)*)/i

export function lineHasAllow(text, ruleId) {
  const match = ALLOW_RE.exec(text)
  if (!match) return false
  return match[1]
    .split(",")
    .map((tag) => tag.trim().toLowerCase())
    .includes(ruleId.toLowerCase())
}

function lineHasStandaloneAllow(text, ruleId) {
  if (!lineHasAllow(text, ruleId)) return false
  return /^(?:\/\/|#|--|\/\*)\s*btrain-allow\s*:/i.test(text.trim())
}

// Whether the immediately previous new-file line carries an allow marker.
function prevLineAllows(lines, line, ruleId) {
  const prev = (lines || []).find((entry) => entry.line === line - 1)
  return prev && lineHasStandaloneAllow(prev.text, ruleId)
}

function lineIsAllowed(text, line, lines, ruleId) {
  return lineHasAllow(text, ruleId) || prevLineAllows(lines, line, ruleId)
}

// ---- code masking (weakened-test rules) ----

const MAX_SCANNED_LINE = 5000
// Joined call text examined for a title, callback or options object.
const CALL_TEXT_LIMIT = 2000

// Blank comments and fill string, template and regex literal contents with
// "x", keeping every other character in its column. Structural scans (call
// starts, brackets, commas) then never read text inside a literal or a
// comment. `code` drops comments only; `masked` also fills literals.
// `state` carries an open template literal, triple-quoted string or block
// comment into the next line. `keepString(content)` keeps a string intact,
// so JSON keys such as "exclude" stay visible.
function createMaskState(file) {
  return { hashComments: HASH_COMMENT_FILE.test(file), quote: null, blockComment: false }
}

function maskLine(text, state, keepString = null) {
  // A very long line is data (minified or generated). Scanning it costs more
  // than it can find, so it reads as blank and leaves the state alone.
  if (text.length > MAX_SCANNED_LINE) {
    const blank = " ".repeat(text.length)
    return { code: blank, masked: blank }
  }
  const code = text.split("")
  const masked = text.split("")
  const blank = (from, to) => {
    for (let k = from; k < to; k++) {
      code[k] = " "
      masked[k] = " "
    }
  }
  const fill = (from, to) => {
    for (let k = from; k < to; k++) masked[k] = "x"
  }
  let carried = Boolean(state.quote)
  let i = 0
  while (i < text.length) {
    if (state.blockComment) {
      const end = text.indexOf("*/", i)
      const stop = end < 0 ? text.length : end + 2
      blank(i, stop)
      i = stop
      if (end >= 0) state.blockComment = false
      continue
    }
    if (state.quote) {
      const close = findClosingQuote(text, i, state.quote)
      const contentEnd = close < 0 ? text.length : close
      if (carried || close < 0 || !keepString?.(text.slice(i, contentEnd))) fill(i, contentEnd)
      carried = false
      if (close < 0) {
        // Plain quotes end with the line; template and triple quotes carry.
        if (state.quote === "\"" || state.quote === "'") state.quote = null
        break
      }
      i = close + state.quote.length
      state.quote = null
      continue
    }
    const ch = text[i]
    if (startsLineComment(text, i, state.hashComments)) {
      blank(i, text.length)
      break
    }
    if (!state.hashComments && text.startsWith("/*", i)) {
      blank(i, i + 2)
      i += 2
      state.blockComment = true
      continue
    }
    const triple = state.hashComments && (text.startsWith("\"\"\"", i) || text.startsWith("'''", i))
    if (triple || ch === "\"" || ch === "'" || ch === "`") {
      state.quote = triple ? text.slice(i, i + 3) : ch
      i += state.quote.length
      continue
    }
    if (!state.hashComments && ch === "/" && regexLiteralCanStart(text, i)) {
      const end = findRegexLiteralEnd(text, i + 1)
      if (end > 0) {
        fill(i + 1, end)
        i = end + 1
        continue
      }
    }
    i++
  }
  return { code: code.join(""), masked: masked.join("") }
}

function maskLines(texts, file, keepString = null) {
  const state = createMaskState(file)
  return texts.map((text) => maskLine(text, state, keepString))
}

function startsLineComment(text, index, hashComments) {
  if (!hashComments) return text.startsWith("//", index)
  // A `#` right after a word character, `$`, `/` or `{` is not a comment:
  // $#, ${#name}, a#b, url/#fragment.
  return text[index] === "#" && !/[\w$/{]/.test(text[index - 1] ?? "")
}

function findClosingQuote(text, from, quote) {
  for (let j = from; j < text.length; j++) {
    if (text[j] === "\\") {
      j++
      continue
    }
    if (text.startsWith(quote, j)) return j
  }
  return -1
}

// A slash starts a regex literal where an expression can begin. Only the
// previous token is examined, so long lines stay linear.
function regexLiteralCanStart(text, index) {
  let j = index - 1
  while (j >= 0 && /\s/.test(text[j])) j--
  if (j < 0 || /[(,=:[!&|?{};+\-*%<>~^]/.test(text[j])) return true
  const tail = text.slice(Math.max(0, j - 7), j + 1)
  return /(?:^|[^\w$])(?:return|typeof|case|do|else|in|of|void|yield|await|delete|throw|new)$/.test(tail)
}

function findRegexLiteralEnd(text, from) {
  let inClass = false
  for (let j = from; j < text.length; j++) {
    const ch = text[j]
    if (ch === "\\") {
      j++
    } else if (inClass) {
      if (ch === "]") inClass = false
    } else if (ch === "[") {
      inClass = true
    } else if (ch === "/") {
      return j
    }
  }
  return -1
}

function bracketDelta(masked) {
  let delta = 0
  for (const ch of masked) {
    if (ch === "(" || ch === "[" || ch === "{") delta++
    else if (ch === ")" || ch === "]" || ch === "}") delta--
  }
  return delta
}

// Slice code and masked text together, trimmed by the masked whitespace so
// both stay aligned column for column. `start` is the slice's offset.
function trimmedSlice(code, masked, start, end) {
  let from = start
  let to = end
  while (from < to && /\s/.test(masked[from])) from++
  while (to > from && /\s/.test(masked[to - 1])) to--
  return { code: code.slice(from, to), masked: masked.slice(from, to), start: from }
}

// Split the bracketed list opened at openIndex into top-level items.
// `closed` is false when the list runs past the end of the text.
function splitTopLevel(code, masked, openIndex) {
  const items = []
  let depth = 0
  let start = openIndex + 1
  const push = (end) => {
    const item = trimmedSlice(code, masked, start, end)
    if (item.masked) items.push(item)
  }
  for (let i = openIndex; i < masked.length; i++) {
    const ch = masked[i]
    if (ch === "(" || ch === "[" || ch === "{") {
      depth++
    } else if (ch === ")" || ch === "]" || ch === "}") {
      depth--
      if (depth === 0) {
        push(i)
        return { items, end: i + 1, closed: true }
      }
    } else if (ch === "," && depth === 1) {
      push(i)
      start = i + 1
    }
  }
  push(masked.length)
  return { items, end: masked.length, closed: false }
}

function splitCallArgs(code, masked, openIndex) {
  const call = splitTopLevel(code, masked, openIndex)
  return call.closed ? { args: call.items, end: call.end } : null
}

function isAssertionCode(masked, file) {
  return ASSERTION_CALL.test(masked) || (PYTHON_FILE.test(file) && PYTHON_ASSERT_STATEMENT.test(masked))
}

function isTestFilePath(file) {
  const base = path.posix.basename(file)
  return TEST_BASENAME_PATTERNS.some((re) => re.test(base)) || TEST_PATH_PATTERNS.some((re) => re.test(file))
}

function isTestConfigFile(file) {
  const base = path.posix.basename(file)
  return JS_TEST_CONFIG_BASENAME.test(base) || PYTHON_TEST_CONFIG_BASENAME.test(base)
}

function textAtNewLine(entry, line) {
  return entry.lines.find((candidate) => candidate.line === line)?.text ?? ""
}

function plural(count, singular, pluralForm = `${singular}s`) {
  return `${count} ${count === 1 ? singular : pluralForm}`
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

// ---- per-rule scanners ----

function scanHardcodedSecret(file, addedLines, lines) {
  const out = []
  for (const { line, text } of addedLines) {
    for (const pattern of SECRET_PATTERNS) {
      if (!pattern.regex.test(text)) continue
      if (lineIsAllowed(text, line, lines, "hardcoded-secret")) continue
      out.push({
        rule: "hardcoded-secret",
        severity: "hard",
        file,
        line,
        preview: text.trim().slice(0, 200),
        detail: `Matched ${pattern.label} (${pattern.id}).`,
      })
      break // one violation per line is enough
    }
  }
  return out
}

function scanCorsWildcard(file, addedLines, lines) {
  const out = []
  for (const { line, text } of addedLines) {
    if (!CORS_WILDCARD_PATTERNS.some((re) => re.test(text))) continue
    if (lineIsAllowed(text, line, lines, "cors-wildcard")) continue
    out.push({
      rule: "cors-wildcard",
      severity: "hard",
      file,
      line,
      preview: text.trim().slice(0, 200),
      detail: "Wildcard CORS origin (`*`) detected.",
    })
  }
  return out
}

function scanEnvVarRequired(file, addedLines, lines) {
  const out = []
  for (const { line, text } of addedLines) {
    const nameMatch = SECRET_VAR_NAME.exec(text)
    if (!nameMatch) continue

    // Look for a string literal of length >= 20 on this line
    const literalMatch = /['"`]([^'"`]{20,})['"`]/.exec(text)
    if (!literalMatch) continue

    // If the literal looks env-derived on this line, skip
    if (ENV_DERIVATIONS.some((re) => re.test(text))) continue

    // Don't double-fire if hardcoded-secret already matches a known pattern
    if (SECRET_PATTERNS.some((p) => p.regex.test(text))) continue

    if (lineIsAllowed(text, line, lines, "env-var-required")) continue

    out.push({
      rule: "env-var-required",
      severity: "warn",
      file,
      line,
      preview: text.trim().slice(0, 200),
      detail: `Variable \`${nameMatch[1]}\` assigned a literal; expected to be loaded from env (process.env / os.environ / ...).`,
    })
  }
  return out
}

// Per-file: if added lines introduce any route handler and the WHOLE file
// (added lines viewed, since we don't read the on-disk file) has no helmet
// or security-header import, flag once.
function scanUnprotectedRoute(file, addedLines, lines) {
  const out = []
  const routeLines = addedLines.filter(({ text }) => ROUTE_PATTERNS.some((re) => re.test(text)))
  if (routeLines.length === 0) return out
  const hasSecurity = addedLines.some(({ text }) => SECURITY_IMPORT_PATTERNS.some((re) => re.test(text)))
  if (hasSecurity) return out
  // Allow markers are per-line; keep scanning later route additions.
  const route = routeLines.find(({ line, text }) => !lineIsAllowed(text, line, lines, "unprotected-route"))
  if (!route) return out
  out.push({
    rule: "unprotected-route",
    severity: "warn",
    file,
    line: route.line,
    preview: route.text.trim().slice(0, 200),
    detail: "New HTTP route added without helmet/security-header import in the same file.",
  })
  return out
}

function countJsonBraceDelta(text) {
  let delta = 0
  let inString = false
  let escaped = false
  for (const ch of text) {
    if (escaped) {
      escaped = false
      continue
    }
    if (ch === "\\") {
      escaped = true
      continue
    }
    if (ch === "\"") {
      inString = !inString
      continue
    }
    if (inString) continue
    if (ch === "{") delta++
    if (ch === "}") delta--
  }
  return delta
}

const PACKAGE_DEPENDENCY_SECTION = /^\s*"(?:dependencies|devDependencies|peerDependencies|optionalDependencies)"\s*:\s*\{/
const PACKAGE_ENTRY = /^\s*"([^"]+)"\s*:\s*"[^"]*"\s*,?\s*(?:\/\/.*)?$/
const TOML_SECTION = /^\s*\[([^\]]+)\]\s*$/
const TOML_ENTRY = /^[A-Za-z0-9_.-]+\s*=\s*['"`{[]/
const TOML_STRING_ARRAY_ENTRY = /^['"][^'"]+['"]\s*,?$/

function collectPackageJsonDependencyLinesFromText(content) {
  const lineNumbers = new Set()
  let inDependencySection = false
  let dependencyDepth = 0
  const lines = String(content || "").split("\n")

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    const lineNumber = index + 1
    if (!inDependencySection && PACKAGE_DEPENDENCY_SECTION.test(line)) {
      inDependencySection = true
      dependencyDepth = Math.max(0, countJsonBraceDelta(line))
      if (dependencyDepth <= 0) {
        inDependencySection = false
      }
      continue
    }

    if (!inDependencySection) continue
    if (dependencyDepth > 0 && PACKAGE_ENTRY.test(line)) {
      lineNumbers.add(lineNumber)
    }
    dependencyDepth += countJsonBraceDelta(line)
    if (dependencyDepth <= 0) {
      inDependencySection = false
      dependencyDepth = 0
    }
  }

  return lineNumbers
}

function collectPackageJsonDependencyLinesFromDiff(lines) {
  const lineNumbers = new Set()
  let inDependencySection = false
  let dependencyDepth = 0

  for (const entry of lines || []) {
    const text = entry.text || ""
    if (!inDependencySection && PACKAGE_DEPENDENCY_SECTION.test(text)) {
      inDependencySection = true
      dependencyDepth = Math.max(0, countJsonBraceDelta(text))
      if (dependencyDepth <= 0) {
        inDependencySection = false
      }
      continue
    }

    if (!inDependencySection) continue
    if (dependencyDepth > 0 && entry.kind === "added" && PACKAGE_ENTRY.test(text)) {
      lineNumbers.add(entry.line)
    }
    dependencyDepth += countJsonBraceDelta(text)
    if (dependencyDepth <= 0) {
      inDependencySection = false
      dependencyDepth = 0
    }
  }

  return lineNumbers
}

function getPackageJsonDependencyLines(file, lines, fileContentsByPath) {
  const content = fileContentsByPath?.[file]
  if (typeof content === "string") {
    return collectPackageJsonDependencyLinesFromText(content)
  }
  return collectPackageJsonDependencyLinesFromDiff(lines)
}

function normalizeTomlSection(section) {
  return String(section || "")
    .trim()
    .toLowerCase()
    .replaceAll("\"", "")
    .replaceAll("'", "")
}

function isCargoDependencySection(section) {
  const normalized = normalizeTomlSection(section)
  return (
    normalized === "dependencies" ||
    normalized === "dev-dependencies" ||
    normalized === "build-dependencies" ||
    normalized === "workspace.dependencies" ||
    normalized.startsWith("dependencies.") ||
    normalized.endsWith(".dependencies") ||
    normalized.includes(".dependencies.")
  )
}

function isPyprojectDependencySection(section) {
  const normalized = normalizeTomlSection(section)
  return (
    normalized === "tool.poetry.dependencies" ||
    normalized === "tool.poetry.dev-dependencies" ||
    normalized === "project.optional-dependencies" ||
    normalized === "dependency-groups" ||
    (normalized.startsWith("tool.poetry.group.") && normalized.endsWith(".dependencies"))
  )
}

function isCargoDependencyEntry(section, text) {
  return isCargoDependencySection(section) && TOML_ENTRY.test(text.trim())
}

function isPyprojectDependencyEntry(section, text) {
  const normalized = normalizeTomlSection(section)
  const trimmed = text.trim()
  if (normalized === "project") {
    return /^(?:dependencies|optional-dependencies)\s*=/.test(trimmed)
  }
  return isPyprojectDependencySection(section) && TOML_ENTRY.test(trimmed)
}

function startsTomlArrayAssignment(text) {
  return /=\s*\[/.test(text)
}

function closesTomlArray(text) {
  return text.includes("]")
}

function collectTomlDependencyLinesFromEntries(entries, isDependencyEntry) {
  const lineNumbers = new Set()
  let currentSection = ""

  for (const entry of entries || []) {
    const text = entry.text || ""
    const sectionMatch = TOML_SECTION.exec(text)
    if (sectionMatch) {
      currentSection = sectionMatch[1]
      continue
    }
    if (entry.kind === "added" && isDependencyEntry(currentSection, text)) {
      lineNumbers.add(entry.line)
    }
  }

  return lineNumbers
}

function collectTomlDependencyLinesFromText(content, isDependencyEntry) {
  const entries = String(content || "")
    .split("\n")
    .map((text, index) => ({ line: index + 1, text, kind: "added" }))
  return collectTomlDependencyLinesFromEntries(entries, isDependencyEntry)
}

function getTomlDependencyLines(file, lines, fileContentsByPath, isDependencyEntry) {
  const content = fileContentsByPath?.[file]
  if (typeof content === "string") {
    return collectTomlDependencyLinesFromText(content, isDependencyEntry)
  }
  return collectTomlDependencyLinesFromEntries(lines, isDependencyEntry)
}

function collectPyprojectDependencyLinesFromEntries(entries) {
  const lineNumbers = new Set()
  let currentSection = ""
  let inDependencyArray = false

  for (const entry of entries || []) {
    const text = entry.text || ""
    const trimmed = text.trim()
    const sectionMatch = TOML_SECTION.exec(text)
    if (sectionMatch) {
      currentSection = sectionMatch[1]
      inDependencyArray = false
      continue
    }

    if (inDependencyArray) {
      if (entry.kind === "added" && TOML_STRING_ARRAY_ENTRY.test(trimmed)) {
        lineNumbers.add(entry.line)
      }
      if (closesTomlArray(trimmed)) {
        inDependencyArray = false
      }
      continue
    }

    if (!isPyprojectDependencyEntry(currentSection, text)) continue
    if (entry.kind === "added") {
      lineNumbers.add(entry.line)
    }
    if (startsTomlArrayAssignment(trimmed) && !closesTomlArray(trimmed)) {
      inDependencyArray = true
    }
  }

  return lineNumbers
}

function collectPyprojectDependencyLinesFromText(content) {
  const entries = String(content || "")
    .split("\n")
    .map((text, index) => ({ line: index + 1, text, kind: "added" }))
  return collectPyprojectDependencyLinesFromEntries(entries)
}

function getPyprojectDependencyLines(file, lines, fileContentsByPath) {
  const content = fileContentsByPath?.[file]
  if (typeof content === "string") {
    return collectPyprojectDependencyLinesFromText(content)
  }
  return collectPyprojectDependencyLinesFromEntries(lines)
}

function getTomlDependencyLinesForFile(base, file, lines, fileContentsByPath) {
  if (base === "Cargo.toml") {
    return getTomlDependencyLines(file, lines, fileContentsByPath, isCargoDependencyEntry)
  }
  if (base === "pyproject.toml") {
    return getPyprojectDependencyLines(file, lines, fileContentsByPath)
  }
  return null
}

function scanNewDependency(file, addedLines, lines, options = {}) {
  const out = []
  const base = path.basename(file)
  const config = DEPENDENCY_FILES.find((d) => d.name === base)
  if (!config) return out
  const packageJsonDependencyLines =
    base === "package.json"
      ? getPackageJsonDependencyLines(file, lines, options.fileContentsByPath)
      : null
  const tomlDependencyLines = getTomlDependencyLinesForFile(base, file, lines, options.fileContentsByPath)

  // For files where every added line counts as a dep (requirements.txt), flag
  // every non-comment, non-empty added line.
  if (config.everyAddedLine) {
    for (const { line, text } of addedLines) {
      const trimmed = text.trim()
      if (!trimmed || trimmed.startsWith("#")) continue
      if (lineIsAllowed(text, line, lines, "new-dependency")) continue
      out.push({
        rule: "new-dependency",
        severity: "warn",
        file,
        line,
        preview: trimmed.slice(0, 200),
        detail: `New dependency line in ${base}.`,
      })
    }
    return out
  }

  // For block-scoped files, we need to know whether each added line is
  // inside a deps block. We don't have full file context here; approximate by
  // checking whether the added line itself looks like a dependency entry
  // (key-value form for json/toml).
  for (const { line, text } of addedLines) {
    const trimmed = text.trim()
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("#") || trimmed.startsWith("/*")) continue
    if (lineIsAllowed(text, line, lines, "new-dependency")) continue

    if (base === "package.json") {
      if (!PACKAGE_ENTRY.test(text) || !packageJsonDependencyLines.has(line)) continue
    } else if (base === "Cargo.toml" || base === "pyproject.toml") {
      if (!tomlDependencyLines.has(line)) continue
    } else if (base === "go.mod") {
      if (!/^(?:require\s+)?[A-Za-z0-9./_-]+\s+v\d/.test(trimmed)) continue
    } else {
      continue
    }

    out.push({
      rule: "new-dependency",
      severity: "warn",
      file,
      line,
      preview: trimmed.slice(0, 200),
      detail: `New dependency entry in ${base}.`,
    })
  }
  return out
}

// ---- weakened-test scanners ----

// Masked rows for one side ("new" or "old") of a file diff. Whole-file
// contents give exact masking; without them each hunk is masked from its own
// first line, which is exact only for a hunk that starts at line 1.
function createSide(entry, sideName, content) {
  const lineKey = sideName === "new" ? "newLine" : "oldLine"
  const otherKind = sideName === "new" ? "removed" : "added"
  const hunkLines = entry.hunks.map((hunk) => hunk.entries.filter((e) => e.kind !== otherKind))
  if (typeof content === "string") {
    const texts = content.split("\n")
    // Use the file only when it is the text the diff describes.
    if (hunkLines.every((entries) => entries.every((e) => texts[e[lineKey] - 1] === e.text))) {
      const rows = maskLines(texts, entry.file)
      return { whole: true, rows, row: (line) => rows[line - 1] ?? null, exact: () => true }
    }
  }
  const byLine = new Map()
  const exactLines = new Set()
  for (const [index, hunk] of entry.hunks.entries()) {
    const entries = hunkLines[index]
    const rows = maskLines(entries.map((e) => e.text), entry.file)
    const startsAtTop = (sideName === "new" ? hunk.newStart : hunk.oldStart) <= 1
    for (const [i, e] of entries.entries()) {
      byLine.set(e[lineKey], rows[i])
      if (startsAtTop) exactLines.add(e[lineKey])
    }
  }
  return { whole: false, rows: null, row: (line) => byLine.get(line) ?? null, exact: (line) => exactLines.has(line) }
}

function createSideView(entry, options) {
  return {
    new: createSide(entry, "new", options.fileContentsByPath?.[entry.file]),
    old: createSide(entry, "old", options.baseFileContentsByPath?.[entry.oldFile]),
  }
}

// Line numbers to scan on one side: the whole file, or each hunk's lines.
function sideRuns(entry, side, sideName) {
  if (side.whole) return [side.rows.map((_, index) => index + 1)]
  const lineKey = sideName === "new" ? "newLine" : "oldLine"
  const otherKind = sideName === "new" ? "removed" : "added"
  return entry.hunks.map((hunk) => hunk.entries.filter((e) => e.kind !== otherKind).map((e) => e[lineKey]))
}

// A call's text from its opening bracket, joined across the following lines
// of the side until it closes (at most maxLines). lineAt maps an offset in
// the joined text back to its line.
function joinCall(side, line, row, openIndex, maxLines) {
  let code = row.code.slice(openIndex, openIndex + CALL_TEXT_LIMIT)
  let masked = row.masked.slice(openIndex, openIndex + CALL_TEXT_LIMIT)
  const starts = [{ offset: 0, line }]
  let depth = bracketDelta(masked)
  for (let next = line + 1; depth > 0 && next < line + maxLines && code.length < CALL_TEXT_LIMIT; next++) {
    const nextRow = side.row(next)
    if (!nextRow) break
    starts.push({ offset: code.length + 1, line: next })
    code += `\n${nextRow.code}`
    masked += `\n${nextRow.masked}`
    depth += bracketDelta(nextRow.masked)
  }
  const lineAt = (offset) => starts.filter((start) => start.offset <= offset).at(-1).line
  return { code, masked, lineAt }
}

// Deleted files have no surviving line, so the finding is file-level
// (line 0) and cannot carry an allow marker; justify it in the handoff.
function scanDeletedTestFile(entry) {
  if (entry.status === "deleted" && isTestFilePath(entry.file)) {
    const rows = maskLines(entry.removed.map((removed) => removed.text), entry.file)
    const assertions = rows.filter((row) => isAssertionCode(row.masked, entry.file)).length
    return [{
      rule: "deleted-test-file",
      severity: "warn",
      file: entry.file,
      line: 0,
      preview: "",
      detail: `Test file deleted (${plural(entry.removed.length, "line")}, ${plural(assertions, "assertion line")}).`,
    }]
  }
  if (entry.status === "renamed" && isTestFilePath(entry.oldFile) && !isTestFilePath(entry.file)) {
    return [{
      rule: "deleted-test-file",
      severity: "warn",
      file: entry.oldFile,
      line: 0,
      preview: `${entry.oldFile} -> ${entry.file}`,
      detail: "Test file renamed to a non-test path, so test runners stop collecting it.",
    }]
  }
  return []
}

function assertionKey(code) {
  return code.trim().replace(/\s+/g, " ")
}

// Per hunk, assertion lines removed versus added. Identical lines cancel
// out, first within a hunk and then anywhere in the file, so a test that
// only moved is not a removal.
function scanRemovedAssertion(entry, view) {
  const hunks = entry.hunks.map((hunk) => {
    const removed = []
    for (const e of hunk.entries) {
      if (e.kind !== "removed") continue
      const row = view.old.row(e.oldLine)
      if (row && isAssertionCode(row.masked, entry.file)) removed.push({ entry: e, key: assertionKey(row.code), moved: false })
    }
    const added = []
    for (const { line } of hunk.added) {
      const row = view.new.row(line)
      if (row && isAssertionCode(row.masked, entry.file)) added.push({ key: assertionKey(row.code), used: false })
    }
    return { removed, added }
  })
  const cancel = (removed, candidates) => {
    const twin = candidates.find((added) => !added.used && added.key === removed.key)
    if (!twin) return
    twin.used = true
    removed.moved = true
  }
  for (const { removed, added } of hunks) {
    for (const r of removed) cancel(r, added)
  }
  const allAdded = hunks.flatMap(({ added }) => added)
  for (const { removed } of hunks) {
    for (const r of removed) if (!r.moved) cancel(r, allAdded)
  }
  const out = []
  for (const { removed, added } of hunks) {
    const lost = removed.filter((r) => !r.moved)
    const gained = added.filter((a) => !a.used).length
    if (lost.length <= gained) continue
    const first = lost[0].entry
    if (lineIsAllowed(textAtNewLine(entry, first.newLine), first.newLine, entry.lines, "removed-assertion")) continue
    out.push({
      rule: "removed-assertion",
      severity: "warn",
      file: entry.file,
      line: first.newLine,
      preview: first.text.trim().slice(0, 200),
      detail: `Hunk removes ${plural(lost.length, "assertion line")} and adds ${gained} (old line ${first.oldLine}).`,
    })
  }
  return out
}

// Top-level properties of test-call options objects on one side, by line:
// test("name", { only: true, retry: 2 }, fn). Arguments after the callback
// are not options, and nested objects never count.
function testOptionProperties(entry, side, sideName) {
  const byLine = new Map()
  for (const run of sideRuns(entry, side, sideName)) {
    for (const line of run) {
      const row = side.row(line)
      if (!row) continue
      for (const match of row.masked.matchAll(TEST_OPTIONS_CALL)) {
        const call = joinCall(side, line, row, match.index + match[0].length - 1, CALL_LOOKAHEAD_LINES)
        for (const arg of splitTopLevel(call.code, call.masked, 0).items.slice(1)) {
          if (CALLBACK_ARG.test(arg.masked)) break
          if (!arg.masked.startsWith("{")) continue
          for (const property of splitTopLevel(arg.code, arg.masked, 0).items) {
            const key = /^["']?([\w$]+)["']?\s*:/.exec(property.code)
            if (!key) continue
            const value = trimmedSlice(property.code, property.masked, key[0].length, property.code.length)
            const at = call.lineAt(arg.start + property.start)
            if (!byLine.has(at)) byLine.set(at, [])
            byLine.get(at).push({ key: key[1], code: value.code, masked: value.masked })
          }
        }
      }
    }
  }
  return byLine
}

function callHasTitleAndCallback(side, line, row, match) {
  if (!match[0].endsWith("(")) return false
  const call = joinCall(side, line, row, match.index + match[0].length - 1, CALL_LOOKAHEAD_LINES)
  const args = splitTopLevel(call.code, call.masked, 0).items
  return args.length >= 2 && args.slice(1).some((arg) => CALLBACK_ARG.test(arg.masked))
}

// Names such as fit or xit that the file defines, or imports from a module
// that is not a test framework: calls to them are helpers, not focus.
function shadowedMarkerNames(entry, side) {
  const code = sideRuns(entry, side, "new").flat().map((line) => side.row(line)?.code ?? "").join("\n")
  const imported = []
  for (const match of code.matchAll(/\bimport\s+([^;'"]*?)\bfrom\s*(["'])([^"'\n]+)\2/g)) imported.push([match[1], match[3]])
  for (const match of code.matchAll(/\b(?:const|let|var)\s*\{([^}]*)\}\s*=\s*require\s*\(\s*(["'])([^"'\n]+)\2/g)) imported.push([match[1], match[3]])
  for (const match of code.matchAll(/\bfrom\s+([\w.]+)\s+import\s+([^\n]*)/g)) imported.push([match[2], match[1]])
  const names = new Set()
  for (const name of PREFIXED_MARKER_NAMES) {
    if (!code.includes(name)) continue
    const word = new RegExp(`\\b${name}\\b`)
    const defined = new RegExp(`\\b(?:function\\s*\\*?\\s*|def\\s+|class\\s+)${name}\\b|\\b(?:const|let|var)\\s+${name}\\s*=`).test(code)
    const importedHelper = imported.some(([clause, module]) => word.test(clause) && !TEST_FRAMEWORK_MODULES.has(module))
    if (defined || importedHelper) names.add(name)
  }
  return names
}

function isSkipValue(masked) {
  return masked === "true" || (/^["'`]/.test(masked) && masked.length > 2)
}

// Focus and skip markers on one line of a side. `id` identifies a marker for
// matching against removed lines; `label` names it in the finding.
function markersOnLine(side, line, optionsByLine, isShadowed, file) {
  const row = side.row(line)
  if (!row) return []
  const markers = []
  const add = (kind, label) => markers.push({ kind, label, id: `${kind}:${label.replace(/\s+/g, "")}` })
  for (const match of row.masked.matchAll(RUNNER_MARKER_CALL)) {
    if (!match[2] && !callHasTitleAndCallback(side, line, row, match)) continue
    add(match[1] === "only" ? "focus" : "skip", match[0].replace(/\s*[(`]$/, ""))
  }
  for (const match of row.masked.matchAll(PREFIXED_MARKER_CALL)) {
    if (isShadowed(match[1])) continue
    if (!match[2] && !callHasTitleAndCallback(side, line, row, match)) continue
    add(match[1].startsWith("f") ? "focus" : "skip", match[0].replace(/\s*[(`]$/, ""))
  }
  for (const property of optionsByLine.get(line) ?? []) {
    if (property.key === "only" && property.masked === "true") add("focus", "only: true")
    if ((property.key === "skip" || property.key === "todo") && isSkipValue(property.masked)) add("skip", `${property.key}:`)
  }
  if (PYTHON_FILE.test(file)) {
    if (/\bpytest\.mark\.skip\b/.test(row.masked)) add("skip", "@pytest.mark.skip")
    if (/@unittest\.skip\s*\(/.test(row.masked)) add("skip", "@unittest.skip")
  }
  return markers
}

// skipped-test and focused-test: markers on added lines that no removed line
// of the same hunk carried, so a moved or re-indented marker is not new. A
// focused test is hard only when both sides were masked from the top of the
// file; hunk-by-hunk masking can mistake a string or comment for code.
function scanTestMarkers(entry, view, newOptions) {
  let shadowed = null
  const isShadowed = (name) => (shadowed ??= shadowedMarkerNames(entry, view.new)).has(name)
  const oldOptions = testOptionProperties(entry, view.old, "old")
  const out = []
  for (const hunk of entry.hunks) {
    if (hunk.added.length === 0) continue
    const existing = hunk.removed.flatMap(({ line }) => markersOnLine(view.old, line, oldOptions, isShadowed, entry.file).map((m) => m.id))
    const oldExact = hunk.removed.every(({ line }) => view.old.exact(line))
    for (const { line, text } of hunk.added) {
      const fresh = {}
      for (const marker of markersOnLine(view.new, line, newOptions, isShadowed, entry.file)) {
        const seen = existing.indexOf(marker.id)
        if (seen >= 0) existing.splice(seen, 1)
        else fresh[marker.kind] ??= marker
      }
      const preview = text.trim().slice(0, 200)
      if (fresh.focus && !lineIsAllowed(text, line, entry.lines, "focused-test")) {
        const exact = view.new.exact(line) && oldExact
        out.push({
          rule: "focused-test",
          severity: exact ? "hard" : "warn",
          file: entry.file,
          line,
          preview,
          detail: `Focused test \`${fresh.focus.label}\` makes the runner skip every other test.` +
            (exact ? "" : " Warn only: the file was masked hunk by hunk, so this may sit in a string or comment."),
        })
      }
      if (fresh.skip && !lineIsAllowed(text, line, entry.lines, "skipped-test")) {
        const label = fresh.skip.label
        out.push({
          rule: "skipped-test",
          severity: "warn",
          file: entry.file,
          line,
          preview,
          detail: /todo/.test(label)
            ? `Test marked todo (\`${label}\`): it still runs, but its failures no longer fail the suite.`
            : `New unconditional skip \`${label}\`.`,
        })
      }
    }
  }
  return out
}

function normalizeSubject(text) {
  return String(text).trim().replace(/^(?:!+\s*|not\s+)/, "").replace(/\s+/g, "").replace(/'/g, "\"")
}

function stripOuterParens(part) {
  let current = part
  while (current.masked.startsWith("(")) {
    const inner = splitTopLevel(current.code, current.masked, 0)
    if (!inner.closed || inner.end !== current.masked.length) break
    current = trimmedSlice(current.code, current.masked, 1, current.masked.length - 1)
  }
  return current
}

// The first top-level comparison in an expression: { left, op } or null.
function splitComparison(part, python) {
  const { code, masked } = stripOuterParens(part)
  let depth = 0
  for (let i = 0; i < masked.length; i++) {
    const ch = masked[i]
    if (ch === "(" || ch === "[" || ch === "{") depth++
    else if (ch === ")" || ch === "]" || ch === "}") depth--
    if (depth !== 0) continue
    if (python) {
      const word = /^\s+(is\s+not|is)\s+/.exec(masked.slice(i, i + 24))
      if (word && i > 0) return { left: code.slice(0, i).trim(), op: word[1].replace(/\s+/g, " ") }
    }
    const op = COMPARISON_OPERATORS.find((candidate) => masked.startsWith(candidate, i))
    if (!op) continue
    // Skip arrows (=>, ->) and shifts (<<, >>).
    if (op === ">" && /[=\->]/.test(masked[i - 1] ?? "")) continue
    if ((op === ">" || op === "<") && masked[i + 1] === op) {
      i++
      continue
    }
    return { left: code.slice(0, i).trim(), op }
  }
  return null
}

function gradeTruthiness(part, label, python) {
  const comparison = splitComparison(part, python)
  if (comparison) {
    return {
      subject: normalizeSubject(comparison.left),
      strict: STRICT_COMPARISONS.has(comparison.op),
      label: `${label} (${comparison.op})`,
    }
  }
  return { subject: normalizeSubject(part.code), strict: false, label }
}

function gradeByName(first, strictNames, looseNames, name, label) {
  if (strictNames.has(name)) return { subject: normalizeSubject(first.code), strict: true, label }
  if (looseNames.has(name)) return { subject: normalizeSubject(first.code), strict: false, label }
  return null
}

function parseNodeAssertion(match, code, masked) {
  const call = splitCallArgs(code, masked, match[0].length - 1)
  if (!call || call.args.length === 0) return null
  const [first] = call.args
  const method = match[1] || "ok"
  const label = match[0].replace(/\s*\($/, "")
  if (method === "ok") return gradeTruthiness(first, label, false)
  if (method === "throws" || method === "rejects") {
    const strict = call.args.length > 1
    return { subject: normalizeSubject(first.code), strict, label: `${label} ${strict ? "with" : "without"} an error matcher` }
  }
  return gradeByName(first, STRICT_NODE_ASSERTS, LOOSE_NODE_ASSERTS, method, label)
}

function parseExpectAssertion(code, masked) {
  const subjectCall = splitCallArgs(code, masked, masked.indexOf("("))
  if (!subjectCall || subjectCall.args.length === 0) return null
  const chain = /^\s*((?:\.\s*(?:not|resolves|rejects)\s*)*)\.\s*(\w+)\s*\(/.exec(masked.slice(subjectCall.end))
  if (!chain) return null
  const matcher = chain[2]
  const negated = /\bnot\b/.test(chain[1])
  const matcherCall = splitCallArgs(code, masked, subjectCall.end + chain[0].length - 1)
  const argCount = matcherCall ? matcherCall.args.length : 0
  const subject = normalizeSubject(subjectCall.args[0].code)
  const label = `expect().${negated ? "not." : ""}${matcher}`
  if (negated) return { subject, strict: false, label }
  if (matcher === "toThrow" || matcher === "toThrowError") {
    return { subject, strict: argCount > 0, label: `${label} ${argCount > 0 ? "with" : "without"} an error matcher` }
  }
  if (matcher === "toHaveProperty") return { subject, strict: argCount > 1, label }
  if (STRICT_EXPECT_MATCHERS.has(matcher)) return { subject, strict: true, label }
  if (LOOSE_EXPECT_MATCHERS.has(matcher)) return { subject, strict: false, label }
  return null
}

function parseUnittestAssertion(match, code, masked) {
  const call = splitCallArgs(code, masked, match[0].length - 1)
  if (!call || call.args.length === 0) return null
  const method = match[1]
  const label = `self.${method}`
  if (method === "assertTrue") return gradeTruthiness(call.args[0], label, true)
  return gradeByName(call.args[0], STRICT_UNITTEST_ASSERTS, LOOSE_UNITTEST_ASSERTS, method, label)
}

function parseRaisesAssertion(code, masked) {
  const call = splitCallArgs(code, masked, masked.indexOf("("))
  if (!call || call.args.length === 0) return null
  const strict = call.args.some((arg) => /^match\s*=/.test(arg.masked))
  return { subject: normalizeSubject(call.args[0].code), strict, label: `pytest.raises ${strict ? "with" : "without"} match=` }
}

// `assert expression, message`: grade the expression before the message.
function parsePythonAssert(code, masked, afterKeyword) {
  let depth = 0
  let end = masked.length
  for (let i = afterKeyword; i < masked.length; i++) {
    const ch = masked[i]
    if (ch === "(" || ch === "[" || ch === "{") depth++
    else if (ch === ")" || ch === "]" || ch === "}") depth--
    else if (ch === "," && depth === 0) {
      end = i
      break
    }
  }
  const expression = trimmedSlice(code, masked, afterKeyword, end)
  return expression.masked ? gradeTruthiness(expression, "assert", true) : null
}

// Parse one assertion statement (its text starts at the assertion) into the
// subject it checks and whether the check is strict. Null when ungraded.
function parseAssertion(code, masked, file) {
  let match = /^self\.(assert[A-Z]\w*)\s*\(/.exec(masked)
  if (match) return parseUnittestAssertion(match, code, masked)
  if (/^pytest\.raises\s*\(/.test(masked)) return parseRaisesAssertion(code, masked)
  if (/^expect\s*\(/.test(masked)) return parseExpectAssertion(code, masked)
  if (PYTHON_FILE.test(file)) {
    match = /^assert\b/.exec(masked)
    return match ? parsePythonAssert(code, masked, match[0].length) : null
  }
  match = /^assert(?:\.strict)?(?:\.(\w+))?\s*\(/.exec(masked)
  return match ? parseNodeAssertion(match, code, masked) : null
}

// `expect(x)` with its matcher on the next line: `expect(x)\n  .toBe(1)`.
function awaitsExpectMatcher(masked, nextMasked) {
  return /^expect\s*\(/.test(masked) && !/\)\s*\.\s*\w+\s*\(/.test(masked) && /^\s*\./.test(nextMasked)
}

function findAssertionStart(masked, file) {
  if (PYTHON_FILE.test(file)) {
    const statement = /^(\s*)assert\b(?!\s*\.)/.exec(masked)
    if (statement) return statement[1].length
  }
  const call = ASSERTION_START.exec(masked)
  return call ? call.index : -1
}

// Assertion statements on one side of a hunk (context plus removed, or
// context plus added). `rows` are the masked rows of those entries. A
// statement joins following lines of the side until its brackets balance,
// and an expect() whose matcher sits on the next line.
function extractAssertionStatements(side, rows, file) {
  const statements = []
  for (let index = 0; index < rows.length; index++) {
    if (!rows[index]) continue
    const start = findAssertionStart(rows[index].masked, file)
    if (start < 0) continue
    let code = rows[index].code.slice(start)
    let masked = rows[index].masked.slice(start)
    let depth = bracketDelta(masked)
    let end = index
    const last = Math.min(rows.length - 1, index + MAX_STATEMENT_LINES - 1)
    const canExtend = () => end < last && rows[end + 1]
    const extend = () => {
      end++
      code += `\n${rows[end].code}`
      masked += `\n${rows[end].masked}`
      depth += bracketDelta(rows[end].masked)
    }
    while (depth > 0 && canExtend()) extend()
    while (depth <= 0 && canExtend() && awaitsExpectMatcher(masked, rows[end + 1].masked)) {
      extend()
      while (depth > 0 && canExtend()) extend()
    }
    const parsed = parseAssertion(code, masked, file)
    if (parsed) statements.push({ ...parsed, start: side[index], entries: side.slice(index, end + 1) })
  }
  return statements
}

function statementAllows(entry, statement, ruleId) {
  return (
    statement.entries.some((e) => lineHasAllow(e.text, ruleId)) ||
    Boolean(prevLineAllows(entry.lines, statement.start.newLine, ruleId))
  )
}

// A strict check on a subject is removed in a hunk, and the only checks on
// that subject the hunk adds (or rewrites in place) are loose.
function scanLoosenedAssertion(entry, view) {
  const out = []
  for (const hunk of entry.hunks) {
    if (hunk.removed.length === 0) continue
    const oldSide = hunk.entries.filter((e) => e.kind !== "added")
    const oldStatements = extractAssertionStatements(oldSide, oldSide.map((e) => view.old.row(e.oldLine)), entry.file)
    const changedOld = oldStatements.filter((s) => s.entries.some((e) => e.kind === "removed"))
    if (!changedOld.some((s) => s.strict)) continue
    const newSide = hunk.entries.filter((e) => e.kind !== "removed")
    const newStatements = extractAssertionStatements(newSide, newSide.map((e) => view.new.row(e.newLine)), entry.file)
    // A multi-line statement can change without an added line (its matcher
    // line was only removed); pair it by the context line it starts on.
    const rewrittenStarts = new Set(changedOld.map((s) => s.start).filter((start) => start.kind === "context"))
    const changedNew = newStatements.filter((s) => s.entries.some((e) => e.kind === "added") || rewrittenStarts.has(s.start))
    const reported = new Set()
    for (const strong of changedOld) {
      if (!strong.strict || reported.has(strong.subject)) continue
      const candidates = changedNew.filter((s) => s.subject === strong.subject)
      if (candidates.length === 0 || candidates.some((s) => s.strict)) continue
      reported.add(strong.subject)
      const [weak] = candidates
      if (statementAllows(entry, weak, "loosened-assertion")) continue
      const subject = strong.subject.length > 80 ? `${strong.subject.slice(0, 77)}...` : strong.subject
      out.push({
        rule: "loosened-assertion",
        severity: "warn",
        file: entry.file,
        line: weak.start.newLine,
        preview: weak.start.text.trim().slice(0, 200),
        detail: `\`${subject}\`: ${strong.label} replaced by ${weak.label}.`,
      })
    }
  }
  return out
}

// A row's code with numbers replaced by NUL (comments already dropped), so
// two lines that differ only in numbers, or in a trailing comment, share a key.
function numberTemplate(row) {
  const line = trimmedSlice(row.code, row.masked, 0, row.code.length)
  const numbers = []
  const key = line.code.replace(NUMBER_LITERAL, (raw, offset) => {
    numbers.push({ raw, offset, value: Number(raw.replaceAll("_", "")), inCode: /\d/.test(line.masked[offset]) })
    return "\u0000"
  })
  return { key, numbers, code: line.code, masked: line.masked }
}

function comparisonBound(prefix, suffix) {
  if (/(?<!>)>=\s*$/.test(prefix) || /(?<![=\->])>\s*$/.test(prefix) || LOWER_BOUND_CALL.test(prefix)) return "lower"
  if (/(?<!<)<=?\s*$/.test(prefix) || UPPER_BOUND_CALL.test(prefix)) return "upper"
  if (/^\s*<(?!<)/.test(suffix)) return "lower"
  if (/^\s*>(?!>)/.test(suffix)) return "upper"
  return null
}

function runCountSettings(keys) {
  return keys.map((key) => ({
    name: key,
    loosens: "lowered",
    scope: "any",
    before: new RegExp(`(?:^|[^\\w$])${escapeRegExp(key)}["']?\\s*(?:[:=]|\\|\\||\\?\\?)\\s*["']?$`),
  }))
}

// The THRESHOLD_SETTINGS scopes that apply to every line of a file.
function thresholdScopes(file) {
  const scopes = new Set(["any"])
  const testConfig = isTestConfigFile(file)
  if (testConfig || COMMAND_FILE.test(file)) scopes.add("config")
  if (testConfig) scopes.add("testConfig").add("runner")
  return scopes
}

function isRunnerRetryLine(row, optionProperties = []) {
  return RUNNER_RETRY_CALL.test(row.masked) || optionProperties.some(({ key }) => key === "retry" || key === "retries")
}

// The first differing number that loosens a setting, or (when checkBounds)
// a comparison bound. Null when no number loosens anything.
function thresholdChange(before, after, settings, scopes, checkBounds) {
  for (let index = 0; index < after.numbers.length; index++) {
    const from = before.numbers[index]
    const to = after.numbers[index]
    if (from.value === to.value) continue
    const lowered = to.value < from.value
    const prefix = after.code.slice(Math.max(0, to.offset - THRESHOLD_WINDOW), to.offset)
    const setting = settings.find((candidate) => scopes.has(candidate.scope) && candidate.before.test(prefix))
    let name = null
    if (setting) {
      if ((setting.loosens === "lowered") === lowered) name = setting.name
    } else if (checkBounds && to.inCode) {
      const suffixStart = to.offset + to.raw.length
      const bound = comparisonBound(prefix, after.code.slice(suffixStart, suffixStart + THRESHOLD_WINDOW))
      if ((bound === "lower" && lowered) || (bound === "upper" && !lowered)) name = `${bound} bound`
    }
    if (name) return { name, direction: lowered ? "lowered" : "raised", from: from.raw, to: to.raw }
  }
  return null
}

function scanLoweredThreshold(entry, view, testOptions, options) {
  const fileScopes = thresholdScopes(entry.file)
  const testFile = isTestFilePath(entry.file)
  const settings = [...options.runCountSettings, ...THRESHOLD_SETTINGS]
  const out = []
  for (const hunk of entry.hunks) {
    if (hunk.removed.length === 0 || hunk.added.length === 0) continue
    // Removed lines with numbers, by template; each pairs with one added line.
    const removedByKey = new Map()
    for (const removed of hunk.removed) {
      const row = view.old.row(removed.line)
      if (!row) continue
      const template = numberTemplate(row)
      if (template.numbers.length === 0) continue
      if (!removedByKey.has(template.key)) removedByKey.set(template.key, [])
      removedByKey.get(template.key).push(template)
    }
    for (const added of hunk.added) {
      const row = view.new.row(added.line)
      if (!row) continue
      const after = numberTemplate(row)
      const before = after.numbers.length > 0 ? removedByKey.get(after.key)?.shift() : undefined
      if (!before) continue
      // In a test file only runner retry settings count as retries, and bare
      // comparisons (>= 10, <= 100) only on assertion lines.
      const runnerLine = testFile && isRunnerRetryLine(row, testOptions.get(added.line))
      const scopes = runnerLine ? new Set([...fileScopes, "runner"]) : fileScopes
      const checkBounds = testFile && isAssertionCode(row.masked, entry.file)
      const change = thresholdChange(before, after, settings, scopes, checkBounds)
      if (!change || lineIsAllowed(added.text, added.line, entry.lines, "lowered-threshold")) continue
      out.push({
        rule: "lowered-threshold",
        severity: "warn",
        file: entry.file,
        line: added.line,
        preview: added.text.trim().slice(0, 200),
        detail: `${change.name} ${change.direction} from ${change.from} to ${change.to}.`,
      })
    }
  }
  return out
}

// Defaults plus configured names, deduplicated; invalid names are dropped.
function resolveKeyList(defaults, configured) {
  const extra = Array.isArray(configured) ? configured : []
  const keys = [...defaults, ...extra]
    .map((key) => String(key ?? "").trim())
    .filter((key) => CONFIG_KEY_NAME.test(key))
  return [...new Set(keys)]
}

function ignoreListKeysFor(file, keys) {
  const scoped = JS_TEST_CONFIG_BASENAME.test(path.posix.basename(file))
  return keys.filter((key) => key !== "exclude" || scoped)
}

function ignoreListMatchers(keys) {
  const names = [...keys].sort((a, b) => b.length - a.length).map(escapeRegExp).join("|")
  const keySet = new Set(keys)
  return {
    // KEY = [ / "KEY": [ / KEY: Type = new Map([ / KEY = Object.freeze({
    opener: new RegExp(`(?:^|[^\\w$])["'\`]?(${names})["'\`]?\\s*(?::[^=\\n]*?)?[:=]\\s*(?:(?:new\\s+)?[\\w.$]+\\s*\\(\\s*)*[\\[{(]`),
    // KEY.push( / KEY.append( / KEY += [
    append: new RegExp(`(?:^|[^\\w$.])(${names})\\s*(?:\\.\\s*(?:append|extend|push|unshift|add|set|insert)\\s*\\(|\\+=)`),
    keepKey: (content) => keySet.has(content),
  }
}

// Ignore-list literals in a contiguous run of new-file lines. A block keeps
// its opener, the bracket depth of its entries and each member line with the
// depth the line starts at. An unterminated block runs to the end of the run.
function findIgnoreListBlocks(run, file, matchers) {
  const rows = maskLines(run.map((row) => row.text), file, matchers.keepKey)
  const blocks = []
  let open = null
  for (const [index, { line, text }] of run.entries()) {
    const { code, masked } = rows[index]
    if (open) {
      const startDepth = open.depth
      open.depth += bracketDelta(masked)
      open.members.push({ line, text, code, masked, startDepth })
      if (open.depth <= 0) {
        blocks.push(open)
        open = null
      }
      continue
    }
    const match = matchers.opener.exec(masked)
    if (!match) continue
    const keyIndex = match.index + match[0].indexOf(match[1])
    const depth = bracketDelta(masked.slice(keyIndex))
    const block = { key: match[1], keyIndex, opener: { index, line, text, code }, entryDepth: depth, depth, members: [] }
    if (depth > 0) open = block
    else blocks.push(block)
  }
  if (open) blocks.push(open)
  return { blocks, rows }
}

const EXCLUDE_PARENT_ON_LINE = new RegExp(`(?:^|[^\\w$])["']?(?:${[...EXCLUDE_PARENT_KEYS].join("|")})["']?\\s*:\\s*\\{[^{}]*$`)

// `exclude` in shared config counts only under a test or coverage key: on
// the opener line before the key, or on a less indented line above it.
function hasTestParentKey(rows, block) {
  if (EXCLUDE_PARENT_ON_LINE.test(block.opener.code.slice(0, block.keyIndex))) return true
  let indent = leadingSpaces(block.opener.code)
  for (let index = block.opener.index - 1; index >= 0 && indent > 0; index--) {
    const { code } = rows[index]
    if (!code.trim()) continue
    const lineIndent = leadingSpaces(code)
    if (lineIndent >= indent) continue
    indent = lineIndent
    const key = /^\s*["']?([\w$-]+)["']?\s*:\s*[{[]/.exec(code)
    if (key && EXCLUDE_PARENT_KEYS.has(key[1])) return true
  }
  return false
}

function leadingSpaces(text) {
  return text.length - text.trimStart().length
}

function openerKeyOn(text, file, matchers) {
  const match = matchers.opener.exec(maskLine(text, createMaskState(file), matchers.keepKey).masked)
  return match ? match[1] : null
}

// A list item compared without whitespace, with quotes unified and trailing
// commas before a closer dropped, so reformatting and requoting match.
function normalizeItem(code) {
  return code.replace(/\s+/g, "").replace(/'/g, "\"").replace(/,(?=[\]})]|$)/g, "")
}

// Top-level items on one line of a list: `"a", "b",` gives two. A line that
// opens a list gives the items after its bracket.
function lineItems(text, file, matchers) {
  const { code, masked } = maskLine(text, createMaskState(file), matchers.keepKey)
  const opener = matchers.opener.exec(masked)
  const start = opener ? opener.index + opener[0].length : 0
  const items = []
  let depth = 0
  let from = start
  const push = (end) => {
    const item = normalizeItem(code.slice(from, end))
    if (item) items.push(item)
  }
  for (let i = start; i < masked.length; i++) {
    const ch = masked[i]
    if (ch === "(" || ch === "[" || ch === "{") {
      depth++
    } else if (ch === ")" || ch === "]" || ch === "}") {
      if (depth === 0) {
        push(i)
        return items
      }
      depth--
    } else if (ch === "," && depth === 0) {
      push(i)
      from = i + 1
    }
  }
  push(masked.length)
  return items
}

// Items not found in the pool; the ones found are used up.
function takeFresh(items, pool) {
  return items.filter((item) => {
    const index = pool.indexOf(item)
    if (index < 0) return true
    pool.splice(index, 1)
    return false
  })
}

// Claim a removed line of the hunk with the same statement, so an append
// that only moved or was re-indented is not new.
function claimRemovedTwin(hunk, text, file, claimed) {
  const normalize = (value) => normalizeItem(maskLine(value, createMaskState(file)).code)
  const wanted = normalize(text)
  const used = claimed.get(hunk) ?? new Set()
  claimed.set(hunk, used)
  const index = hunk.removed.findIndex((removed, i) => !used.has(i) && normalize(removed.text) === wanted)
  if (index < 0) return false
  used.add(index)
  return true
}

function isListEntry(masked) {
  const trimmed = masked.trim()
  return trimmed !== "" && !/^[\]}),;]+$/.test(trimmed)
}

function scanIgnoreListEntries(entry, keys, fileContentsByPath) {
  const loaded = fileContentsByPath?.[entry.file]
  // A loaded file that never names a key holds no list to add to.
  if (typeof loaded === "string" && !keys.some((key) => loaded.includes(key))) return []
  const matchers = ignoreListMatchers(keys)
  const hunkByAddedLine = new Map()
  for (const hunk of entry.hunks) {
    for (const { line } of hunk.added) hunkByAddedLine.set(line, hunk)
  }
  // Every item a removed line held. An added entry that matches one was
  // reformatted, requoted or moved rather than added.
  const removedItems = entry.removed.flatMap((removed) => lineItems(removed.text, entry.file, matchers))
  // Whole-file contents find lists that open above the hunk; without them
  // each hunk's new side is scanned on its own.
  const runs = typeof loaded === "string"
    ? [loaded.split("\n").map((text, index) => ({ line: index + 1, text }))]
    : entry.hunks.map((hunk) => hunk.entries.filter((e) => e.kind !== "removed").map((e) => ({ line: e.newLine, text: e.text })))
  const sharedConfig = SHARED_CONFIG_BASENAME.test(path.posix.basename(entry.file))
  const claimed = new Map()
  const reported = new Set()
  const out = []
  const report = (line, text, detail) => {
    if (reported.has(line) || lineIsAllowed(text, line, entry.lines, "test-ignore-added")) return
    reported.add(line)
    out.push({ rule: "test-ignore-added", severity: "warn", file: entry.file, line, preview: text.trim().slice(0, 200), detail })
  }
  for (const run of runs) {
    const { blocks, rows } = findIgnoreListBlocks(run, entry.file, matchers)
    for (const block of blocks) {
      if (block.key === "exclude" && sharedConfig && !hasTestParentKey(rows, block)) continue
      const openerHunk = hunkByAddedLine.get(block.opener.line)
      if (openerHunk) {
        // A rewritten opener line is an existing list only when a removed
        // line of the same hunk opened the same key; otherwise the list is new.
        if (!openerHunk.removed.some((removed) => openerKeyOn(removed.text, entry.file, matchers) === block.key)) continue
        const fresh = takeFresh(lineItems(block.opener.text, entry.file, matchers), removedItems)
        if (fresh.length > 0) {
          report(block.opener.line, block.opener.text, `Adds ${plural(fresh.length, "entry", "entries")} to the existing \`${block.key}\` list.`)
        }
      }
      for (const member of block.members) {
        if (member.startDepth !== block.entryDepth || !isListEntry(member.masked)) continue
        if (!hunkByAddedLine.has(member.line)) continue
        if (takeFresh(lineItems(member.text, entry.file, matchers), removedItems).length === 0) continue
        report(member.line, member.text, `New entry in the existing \`${block.key}\` list (opened at line ${block.opener.line}).`)
      }
    }
  }
  // Appends to a list defined elsewhere: KEY.push(...), KEY.append(...), KEY += [...]
  for (const hunk of entry.hunks) {
    const side = hunk.entries.filter((e) => e.kind !== "removed")
    const rows = maskLines(side.map((e) => e.text), entry.file, matchers.keepKey)
    for (const [index, e] of side.entries()) {
      if (e.kind !== "added") continue
      const match = matchers.append.exec(rows[index].masked)
      if (!match || claimRemovedTwin(hunk, e.text, entry.file, claimed)) continue
      report(e.newLine, e.text, `Adds an entry to the existing \`${match[1]}\` list.`)
    }
  }
  return out
}

function flagOccurrences(text, file) {
  const { code } = maskLine(text, createMaskState(file))
  return [...code.matchAll(IGNORE_FLAG)].map((match) => `${match[1]} ${match[2]}`.trim())
}

// --deselect / --test-skip-pattern occurrences that no removed line of the
// same hunk already had.
function scanIgnoreFlags(entry) {
  const out = []
  for (const hunk of entry.hunks) {
    if (hunk.added.length === 0) continue
    const existing = hunk.removed.flatMap((removed) => flagOccurrences(removed.text, entry.file))
    for (const added of hunk.added) {
      const fresh = []
      for (const occurrence of flagOccurrences(added.text, entry.file)) {
        const index = existing.indexOf(occurrence)
        if (index >= 0) existing.splice(index, 1)
        else fresh.push(occurrence)
      }
      if (fresh.length === 0 || lineIsAllowed(added.text, added.line, entry.lines, "test-ignore-added")) continue
      out.push({
        rule: "test-ignore-added",
        severity: "warn",
        file: entry.file,
        line: added.line,
        preview: added.text.trim().slice(0, 200),
        detail: `Adds \`${fresh.join("`, `")}\` to a test command.`,
      })
    }
  }
  return out
}

function scanTestIgnoreAdded(entry, options) {
  if (entry.added.length === 0) return []
  const out = []
  const keys = ignoreListKeysFor(entry.file, options.ignoreListKeys)
  if (keys.length > 0) out.push(...scanIgnoreListEntries(entry, keys, options.fileContentsByPath))
  if (COMMAND_FILE.test(entry.file) || isTestConfigFile(entry.file)) out.push(...scanIgnoreFlags(entry))
  return out
}

function scanWeakenedTests(entry, options) {
  const out = scanDeletedTestFile(entry)
  if (entry.status === "deleted" || DOC_FILE.test(entry.file)) return out
  const view = createSideView(entry, options)
  const testFile = isTestFilePath(entry.file)
  const testOptions = testFile ? testOptionProperties(entry, view.new, "new") : new Map()
  if (testFile) {
    out.push(
      ...scanRemovedAssertion(entry, view),
      ...scanTestMarkers(entry, view, testOptions),
      ...scanLoosenedAssertion(entry, view),
    )
  }
  out.push(...scanLoweredThreshold(entry, view, testOptions, options), ...scanTestIgnoreAdded(entry, options))
  return out
}

// ---- public scan entry ----

// Options:
//   fileContentsByPath      new-side contents by path (dependency manifests,
//                           ignore-list files, test files)
//   baseFileContentsByPath  old-side contents by old path (test files)
//   ignoreListKeys          test-ignore-added list names beyond the defaults
//   runCountKeys            lowered-threshold run-count names beyond the defaults
export function scanDiff(diff, options = {}) {
  const files = parseUnifiedDiff(diff)
  const weakenedTestOptions = {
    fileContentsByPath: options.fileContentsByPath,
    baseFileContentsByPath: options.baseFileContentsByPath,
    ignoreListKeys: resolveKeyList(DEFAULT_IGNORE_LIST_KEYS, options.ignoreListKeys),
    runCountSettings: runCountSettings(resolveKeyList(DEFAULT_RUN_COUNT_KEYS, options.runCountKeys)),
  }
  const violations = []
  for (const entry of files) {
    const { file, added, lines } = entry
    if (added.length > 0) {
      violations.push(...scanHardcodedSecret(file, added, lines))
      violations.push(...scanCorsWildcard(file, added, lines))
      violations.push(...scanEnvVarRequired(file, added, lines))
      violations.push(...scanUnprotectedRoute(file, added, lines))
      violations.push(...scanNewDependency(file, added, lines, options))
    }
    // Deletions and removal-only hunks still matter here.
    violations.push(...scanWeakenedTests(entry, weakenedTestOptions))
  }
  // Stable sort: by file, then line, then rule.
  violations.sort((a, b) => {
    if (a.file !== b.file) return a.file < b.file ? -1 : 1
    if (a.line !== b.line) return a.line - b.line
    return a.rule.localeCompare(b.rule)
  })
  return {
    violations,
    summary: {
      hard: violations.filter((v) => v.severity === "hard").length,
      warn: violations.filter((v) => v.severity === "warn").length,
    },
  }
}

// ---- diff fetching ----

function normalizePathspecList(paths) {
  return [...new Set(
    (paths || [])
      .map((value) => String(value || "").trim())
      .filter(Boolean),
  )].sort()
}

async function getLanePathspecs(repoRoot, laneId) {
  if (!laneId) return []
  const normalizedLaneId = String(laneId).trim().toLowerCase()
  const config = await readProjectConfig(repoRoot)
  const laneConfigs = getLaneConfigs(config)
  if (!laneConfigs) {
    throw new BtrainError({
      message: "`btrain review code --lane` requires lanes to be enabled.",
      reason: "The repo does not have [lanes] enabled in .btrain/project.toml.",
      fix: "Run without --lane, or enable lanes with `btrain init`.",
    })
  }
  if (!laneConfigs.some((lane) => lane.id === normalizedLaneId)) {
    throw new BtrainError({
      message: `Unknown lane "${laneId}".`,
      reason: "No configured lane has that id.",
      fix: `Pick one of: ${laneConfigs.map((lane) => lane.id).join(", ")}`,
    })
  }

  const registry = await readLockRegistry(repoRoot)
  const lockPaths = normalizePathspecList(
    registry.locks
      ?.filter((lock) => lock.lane === normalizedLaneId)
      .map((lock) => lock.path),
  )
  if (lockPaths.length > 0) return lockPaths

  const laneStates = await readAllLaneStates(repoRoot, config)
  const laneState = laneStates?.find((entry) => entry._laneId === normalizedLaneId)
  const statePaths = normalizePathspecList(laneState?.lockedFiles)
  if (statePaths.length > 0) return statePaths

  throw new BtrainError({
    message: `Lane "${laneId}" has no locked files to review.`,
    reason: "Lane-scoped review needs the lane's file locks so unrelated lane diffs are excluded.",
    fix: `Run \`btrain handoff update --lane ${normalizedLaneId} --files "path/" --actor "<owner>"\`, then retry.`,
  })
}

async function hasHeadCommit(repoRoot) {
  try {
    await execFileAsync("git", ["rev-parse", "--verify", "HEAD"], { cwd: repoRoot })
    return true
  } catch {
    return false
  }
}

async function execDiff(repoRoot, args) {
  const { stdout } = await execFileAsync("git", args, { cwd: repoRoot, maxBuffer: DIFF_MAX_BUFFER })
  return stdout
}

// Pin the diff format against local git config: rename detection on
// (diff.renames), a/ and b/ prefixes (diff.noprefix, diff.mnemonicPrefix),
// no color, no external diff driver.
const DIFF_FORMAT_ARGS = ["--unified=3", "--find-renames", "--no-color", "--no-ext-diff", "--src-prefix=a/", "--dst-prefix=b/"]

async function getLaneDiff(repoRoot, { base, head, lane }) {
  // If both base and head are provided, diff between them.
  // Otherwise, default to HEAD vs index/worktree so staged-only edits are
  // included in local pre-handoff scans.
  const args = ["diff", ...DIFF_FORMAT_ARGS]
  const pathspecs = await getLanePathspecs(repoRoot, lane)
  if (base) {
    args.push(`${base}${head ? `..${head}` : ""}`)
  } else if (head) {
    args.push(head)
  } else if (await hasHeadCommit(repoRoot)) {
    args.push("HEAD")
  } else {
    const pathArgs = pathspecs.length > 0 ? ["--", ...pathspecs] : []
    const cached = await execDiff(repoRoot, ["diff", "--cached", ...DIFF_FORMAT_ARGS, ...pathArgs])
    const unstaged = await execDiff(repoRoot, ["diff", ...DIFF_FORMAT_ARGS, ...pathArgs])
    return [cached, unstaged].filter(Boolean).join("\n")
  }
  if (pathspecs.length > 0) {
    args.push("--", ...pathspecs)
  }
  return execDiff(repoRoot, args)
}

// Contents of `paths` at `ref`, read with one `git cat-file --batch`, or
// from the worktree when ref is null. Files that are missing are left out.
async function readContents(repoRoot, ref, paths) {
  const files = [...new Set(paths)].filter((file) => file && !file.includes("\n"))
  if (files.length === 0) return {}
  if (ref) return readBlobsAtRef(repoRoot, ref, files)
  const contents = {}
  for (const file of files) {
    try {
      contents[file] = await fs.readFile(path.join(repoRoot, file), "utf8")
    } catch {
      // Deleted or unreadable: the rules fall back to hunk-by-hunk masking.
    }
  }
  return contents
}

function readBlobsAtRef(repoRoot, ref, files) {
  return new Promise((resolve) => {
    const child = spawn("git", ["cat-file", "--batch"], { cwd: repoRoot, stdio: ["pipe", "pipe", "ignore"] })
    const chunks = []
    child.stdout.on("data", (chunk) => chunks.push(chunk))
    child.on("error", () => resolve({}))
    child.on("close", () => resolve(parseCatFileBatch(Buffer.concat(chunks), files)))
    child.stdin.on("error", () => {})
    child.stdin.end(files.map((file) => `${ref}:${file}\n`).join(""))
  })
}

// `git cat-file --batch` answers each request with "<oid> <type> <size>\n"
// and the content plus "\n", or with "<name> missing\n".
function parseCatFileBatch(buffer, files) {
  const contents = {}
  let offset = 0
  for (const file of files) {
    const newline = buffer.indexOf(10, offset)
    if (newline < 0) break
    const header = /^\S+ (\S+) (\d+)$/.exec(buffer.toString("utf8", offset, newline))
    offset = newline + 1
    if (!header) continue
    const size = Number(header[2])
    if (header[1] === "blob") contents[file] = buffer.toString("utf8", offset, offset + size)
    offset += size + 1
  }
  return contents
}

const GREP_PATH_CHUNK = 200

// Paths among `files` whose content at `ref` contains any needle. One
// `git grep` per chunk instead of a read per file.
async function filesMentioningAtRef(repoRoot, ref, files, needles) {
  const found = []
  for (let index = 0; index < files.length; index += GREP_PATH_CHUNK) {
    const chunk = files.slice(index, index + GREP_PATH_CHUNK)
    const args = ["--literal-pathspecs", "grep", "-l", "-z", "-F", ...needles.flatMap((needle) => ["-e", needle]), ref, "--", ...chunk]
    try {
      const { stdout } = await execFileAsync("git", args, { cwd: repoRoot, maxBuffer: DIFF_MAX_BUFFER })
      for (const name of stdout.split("\0")) {
        if (name.startsWith(`${ref}:`)) found.push(name.slice(ref.length + 1))
      }
    } catch (error) {
      // Exit 1 means no match; any other failure falls back to reading all.
      if (error?.code !== 1) found.push(...chunk)
    }
  }
  return found
}

// Contents of the files that mention an ignore-list key that applies to
// them (`exclude` only in JS test config), grepped once per key set.
async function readIgnoreListContents(repoRoot, ref, files, keys) {
  const groups = new Map()
  for (const file of files) {
    const needles = ignoreListKeysFor(file, keys)
    if (needles.length === 0) continue
    const id = needles.join("\0")
    if (!groups.has(id)) groups.set(id, { needles, files: [] })
    groups.get(id).files.push(file)
  }
  const contents = {}
  for (const { needles, files: group } of groups.values()) {
    const mentioning = ref ? await filesMentioningAtRef(repoRoot, ref, group, needles) : group
    for (const [file, content] of Object.entries(await readContents(repoRoot, ref, mentioning))) {
      if (needles.some((needle) => content.includes(needle))) contents[file] = content
    }
  }
  return contents
}

// File contents the rules need beyond the hunks. New side: dependency
// manifests, ignore-list files, and test files (masked whole, since a string
// or comment can open above a hunk). Old side: test files with removals.
async function readReviewFileContents(repoRoot, diff, { newRef, oldRef }, ignoreListKeys) {
  const newPaths = new Set()
  const oldPaths = new Set()
  const listCandidates = []
  for (const entry of parseUnifiedDiff(diff)) {
    if (DEPENDENCY_FILES.some((dependency) => dependency.name === path.basename(entry.file))) newPaths.add(entry.file)
    if (entry.status === "deleted") continue
    if (isTestFilePath(entry.file)) {
      if (entry.hunks.some((hunk) => hunk.newStart > 1)) newPaths.add(entry.file)
      if (entry.hunks.some((hunk) => hunk.removed.length > 0 && hunk.oldStart > 1)) oldPaths.add(entry.oldFile)
    }
    if (entry.added.length > 0 && !DOC_FILE.test(entry.file) && !newPaths.has(entry.file)) listCandidates.push(entry.file)
  }
  const newContents = await readContents(repoRoot, newRef, [...newPaths])
  Object.assign(newContents, await readIgnoreListContents(repoRoot, newRef, listCandidates, ignoreListKeys))
  const oldContents = oldRef ? await readContents(repoRoot, oldRef, [...oldPaths]) : {}
  return { newContents, oldContents }
}

// Where the diff's two sides live. The new side is `head` for a base..head
// range and the worktree otherwise; the old side is what the diff compares
// against.
async function getReviewContentRefs(repoRoot, { base, head }) {
  const newRef = base && head ? head : null
  const oldRef = base || head || ((await hasHeadCommit(repoRoot)) ? "HEAD" : null)
  return { newRef, oldRef }
}

// `[review_code]` in .btrain/project.toml, or {} when there is none.
async function readReviewCodeConfig(repoRoot) {
  try {
    const config = await readProjectConfig(repoRoot)
    return config?.review_code ?? {}
  } catch {
    return {}
  }
}

// ---- formatting ----

export function formatSummary(result) {
  const { violations, summary } = result
  const lines = []
  lines.push(`btrain review code: ${summary.hard} hard, ${summary.warn} warn (${violations.length} total)`)
  if (violations.length === 0) {
    lines.push("  ✓ no violations")
    return lines.join("\n")
  }
  for (const v of violations) {
    const sev = v.severity === "hard" ? "✖" : "⚠"
    // Line 0 marks a file-level finding such as a deleted test file.
    const location = v.line > 0 ? `${v.file}:${v.line}` : v.file
    lines.push(`  ${sev} [${v.rule}] ${location}`)
    if (v.detail) lines.push(`      ${v.detail}`)
    if (v.preview) lines.push(`      > ${v.preview}`)
  }
  return lines.join("\n")
}

// ---- entry ----

export async function reviewCode(repoRoot, options = {}) {
  const diff = await getLaneDiff(repoRoot, {
    base: options.base,
    head: options.head,
    lane: options.lane,
  })
  const config = await readReviewCodeConfig(repoRoot)
  const ignoreListKeys = resolveKeyList(DEFAULT_IGNORE_LIST_KEYS, config.ignore_list_keys)
  const runCountKeys = resolveKeyList(DEFAULT_RUN_COUNT_KEYS, config.run_count_keys)
  const { newContents, oldContents } = await readReviewFileContents(
    repoRoot,
    diff,
    await getReviewContentRefs(repoRoot, options),
    ignoreListKeys,
  )
  const result = scanDiff(diff, {
    fileContentsByPath: newContents,
    baseFileContentsByPath: oldContents,
    ignoreListKeys,
    runCountKeys,
  })
  return result
}

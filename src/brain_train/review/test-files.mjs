// Test files and test-runner or coverage configuration files, by name. One
// list for `btrain review code` (code-rules.mjs, the weakened-test rules) and
// the spec 023 fix rules (fix-rules.mjs, which count the existing test lines a
// reviewer fix changes). It imports nothing, so the pure fix rules can use it
// without importing code-rules.mjs and, through it, core.mjs.

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

/** True for a test file by its runner naming convention alone (a posix path). */
export function isNamedTestFile(file) {
  const target = String(file || "")
  const base = target.split("/").pop()
  return TEST_BASENAME_PATTERNS.some((re) => re.test(base)) || TEST_PATH_PATTERNS.some((re) => re.test(target))
}

// Shared files such as package.json, pyproject.toml, and setup.cfg are listed
// because they commonly carry test scripts and settings.

export const JS_TEST_CONFIG_BASENAME =
  /^(?:(?:jest|vitest|vite|playwright|cypress|karma|wdio|ava|mocha)(?:\.[\w-]+)*\.(?:[cm]?[jt]s|json)|karma\.conf\.[cm]?js|\.(?:mocharc|nycrc|c8rc)(?:\.(?:json|ya?ml|[cm]?js))?|package\.json)$/

export const PYTHON_TEST_CONFIG_BASENAME = /^(?:\.coveragerc|\.?codecov\.ya?ml|pytest\.ini|tox\.ini|setup\.cfg|pyproject\.toml|conftest\.py)$/

/** True for a test-runner or coverage configuration file, by its basename. */
export function isTestConfigBasename(basename) {
  const name = String(basename || "")
  return JS_TEST_CONFIG_BASENAME.test(name) || PYTHON_TEST_CONFIG_BASENAME.test(name)
}

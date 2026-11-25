// Test-runner and coverage configuration files, by basename. One list for
// `btrain review code` (code-rules.mjs, the weakened-test rules) and the
// spec 023 fix rules (fix-rules.mjs, which count the existing test lines a
// reviewer fix changes). It imports nothing, so the pure fix rules can use it
// without importing code-rules.mjs and, through it, core.mjs.
//
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

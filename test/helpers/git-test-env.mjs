// Preloaded by the npm test scripts (`node --import ./test/helpers/git-test-env.mjs
// --test ...`), so every git the suite spawns -- directly or through the btrain
// CLI -- inherits it.
//
// Git runs `git maintenance run --auto --detach` after commit, merge, fetch and
// friends. On the git 2.55 that GitHub's ubuntu runners ship, that detached
// child repacks a freshly bootstrapped test repo (`btrain init` + commit leaves
// ~230 loose objects): `git repack -d -l --cruft --write-midx` keeps writing into
// .git/objects/pack, .git/objects/info and .git/info after the commit has
// returned. A test's teardown `fs.rm(dir, { recursive: true })` then races it
// and fails with ENOTEMPTY on whichever directory gained an entry, failing a
// suite unrelated to the PR under test. Turning auto maintenance off removes
// the background writer instead of retrying around it.
//
// GIT_CONFIG_COUNT entries apply at command-line scope (git 2.31+), above any
// repo or global config, and travel through env inheritance where a per-repo
// `git config` would need every test's init helper to remember it.
const GIT_TEST_CONFIG = [
  ["maintenance.auto", "false"],
  // Also stops the gc task inside `maintenance run --auto`, and covers gits
  // before 2.29, which run `git gc --auto` directly.
  ["gc.auto", "0"],
]

/**
 * Return a copy of `env` with git auto-maintenance turned off, appended after
 * any GIT_CONFIG_COUNT entries already present. Idempotent: a key already set
 * through GIT_CONFIG_KEY_<n> is left alone, so a second preload (node --test
 * forwards --import to each test file's process, which also inherits the
 * parent's env) does not stack duplicates.
 */
export function withGitAutoMaintenanceOff(env = process.env) {
  const next = { ...env }
  let count = Number.parseInt(next.GIT_CONFIG_COUNT || "0", 10)
  if (!Number.isInteger(count) || count < 0) {
    count = 0
  }
  const present = new Set()
  for (let index = 0; index < count; index += 1) {
    present.add(next[`GIT_CONFIG_KEY_${index}`])
  }
  for (const [key, value] of GIT_TEST_CONFIG) {
    if (present.has(key)) {
      continue
    }
    next[`GIT_CONFIG_KEY_${count}`] = key
    next[`GIT_CONFIG_VALUE_${count}`] = value
    count += 1
  }
  next.GIT_CONFIG_COUNT = String(count)
  return next
}

Object.assign(process.env, withGitAutoMaintenanceOff(process.env))

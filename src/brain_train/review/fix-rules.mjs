// Spec 023 FR-11 (task T033): when a reviewer may apply a fix with
// `btrain handoff fix`. One check and one message for each condition. Pure:
// the caller gathers the git facts (the commits of the range with their times
// and `Btrain-Agent` trailers, the changed paths and line count, the test
// lines touched, and the weakened-test findings of `btrain review code`) and
// passes them in. No import of core.mjs.
//
// Facts:
//   tier                       the active attempt's review tier
//   fixesEnabled               [review.fixes].enabled
//   attempt                    { head, startedAt, reviewer } of the active attempt
//   fixBase                    the commit the fix range starts from
//   fixHeadDescendsFromBase    git merge-base --is-ancestor fixBase fixHead
//   commits                    [{ sha, committedAt, trailerAgent }] in fixBase..fixHead
//   files                      paths changed in the range
//   lockedFiles                the lane's locked files and directories
//   changedLines               lines added plus lines removed in the range
//   testLinesRemovedOrChanged  existing lines of test files or test config removed or changed
//   weakenedTestFindings       hard weakened-test findings of `btrain review code` on the range
//   round                      this fix's number since the lane's claim (1 for the first)
//   limits                     { maxFiles, maxChangedLines, maxRounds } from [review.fixes]

import { isNamedTestFile, isTestConfigBasename } from "./test-files.mjs"

export const FIX_RULES = Object.freeze([
  {
    id: "tier",
    check: (facts) => facts.tier === "other-lab",
    message: () => "Only an other-lab reviewer can apply a fix. This attempt is same-lab: use `btrain handoff request-changes`.",
  },
  {
    id: "enabled",
    check: (facts) => facts.fixesEnabled === true,
    message: () => "Reviewer fixes are off in this repository ([review.fixes].enabled = false). Use `btrain handoff request-changes`.",
  },
  {
    id: "base",
    check: (facts) => Boolean(facts.fixBase) && facts.fixBase === facts.attempt?.head,
    message: (facts) => `The fix range must start at the head this attempt reviewed (${facts.attempt?.head || "unknown"}), not at ${facts.fixBase || "an unknown commit"}.`,
  },
  {
    id: "descends",
    check: (facts) => facts.fixHeadDescendsFromBase === true,
    message: () => "The fix head does not descend from the reviewed head. Commit the fix on top of the lane's branch.",
  },
  {
    id: "commits",
    check: (facts) => Array.isArray(facts.commits) && facts.commits.length > 0,
    message: () => "The fix range has no commits. Commit the fix before `btrain handoff fix`.",
  },
  {
    id: "commit-time",
    check: (facts) => {
      const startedAt = Date.parse(facts.attempt?.startedAt || "")
      return (facts.commits || []).every((commit) => {
        const at = Date.parse(commit?.committedAt || "")
        return !Number.isNaN(startedAt) && !Number.isNaN(at) && at > startedAt
      })
    },
    message: () => "Every commit in the fix range must be made after this review attempt started. The range holds an older commit.",
  },
  {
    id: "trailer",
    check: (facts) => (facts.commits || []).every((commit) => sameAgent(commit?.trailerAgent, facts.attempt?.reviewer)),
    message: (facts) => `Every commit in the fix range must carry the trailer \`Btrain-Agent: ${facts.attempt?.reviewer || "<reviewer>"}\`. A commit made with --no-verify, or by another agent, has none.`,
  },
  {
    id: "locked-files",
    check: (facts) => (facts.files || []).every((file) => inLockedFiles(file, facts.lockedFiles)),
    message: (facts) => `The fix changes files outside the lane's locked files: ${(facts.files || []).filter((file) => !inLockedFiles(file, facts.lockedFiles)).join(", ")}.`,
  },
  {
    id: "max-files",
    check: (facts) => (facts.files || []).length <= limit(facts, "maxFiles"),
    message: (facts) => `The fix changes ${(facts.files || []).length} files; the limit is ${limit(facts, "maxFiles")} ([review.fixes].max_files).`,
  },
  {
    id: "max-lines",
    check: (facts) => Number(facts.changedLines) <= limit(facts, "maxChangedLines"),
    message: (facts) => `The fix changes ${Number(facts.changedLines)} lines; the limit is ${limit(facts, "maxChangedLines")} ([review.fixes].max_changed_lines).`,
  },
  {
    id: "test-lines",
    check: (facts) => Number(facts.testLinesRemovedOrChanged) === 0,
    message: () => "The fix removes or changes an existing line of a test file or test configuration. Adding tests is allowed; changing them goes through request-changes.",
  },
  {
    id: "weakened-tests",
    check: (facts) => Number(facts.weakenedTestFindings) === 0,
    message: () => "`btrain review code` reports a hard weakened-test finding on the fix range.",
  },
  {
    id: "rounds",
    check: (facts) => Number(facts.round) <= limit(facts, "maxRounds"),
    message: (facts) => `This lane has had ${Math.max(0, Number(facts.round) - 1)} reviewer fixes since its claim; the limit is ${limit(facts, "maxRounds")} ([review.fixes].max_rounds).`,
  },
].map((rule) => Object.freeze(rule)))

function limit(facts, key) {
  const value = Number(facts.limits?.[key])
  return Number.isFinite(value) ? value : 0
}

function sameAgent(left, right) {
  const a = typeof left === "string" ? left.trim().toLowerCase() : ""
  const b = typeof right === "string" ? right.trim().toLowerCase() : ""
  return Boolean(a) && a === b
}

function normalizePath(value) {
  return String(value || "").trim().replace(/^\.\/+/, "")
}

/** True when `file` is a locked file or under a locked directory. */
export function inLockedFiles(file, lockedFiles) {
  const target = normalizePath(file)
  if (!target) return false
  return (Array.isArray(lockedFiles) ? lockedFiles : []).some((lock) => {
    const entry = normalizePath(lock)
    if (!entry) return false
    if (entry.endsWith("/")) return target.startsWith(entry)
    return target === entry || target.startsWith(`${entry}/`)
  })
}

// Files under a test directory, for the caller that counts the existing lines
// a fix removes or changes. Named test files and test configuration come from
// test-files.mjs.
const TEST_DIR_PATTERN = /(^|\/)(test|tests|__tests__|spec|specs\/tla)\//

/**
 * True for a test file or a test configuration file. Test files and
 * configuration are the lists `btrain review code` uses (test-files.mjs):
 * colocated tests by runner naming convention (foo_test.go, FooTest.java),
 * and shared files that carry test settings (package.json, pyproject.toml,
 * setup.cfg).
 */
export function isTestPath(file) {
  const target = normalizePath(file)
  return TEST_DIR_PATTERN.test(target)
    || isNamedTestFile(target)
    || isTestConfigBasename(target.split("/").pop())
}

/**
 * Check every FR-11 condition. Returns `{ ok, failures }`, where each failure
 * is `{ id, message }` and every condition has its own message.
 */
export function evaluateFixRules(facts = {}) {
  const failures = []
  for (const rule of FIX_RULES) {
    if (!rule.check(facts)) failures.push({ id: rule.id, message: rule.message(facts) })
  }
  return { ok: failures.length === 0, failures }
}

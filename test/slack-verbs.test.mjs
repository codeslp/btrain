// Spec 025 FR-3, FR-4, FR-8 through src/brain_train/slack/verbs.mjs (plan
// WS1, T007): the verb table, its templates, value checks, and the auto list.
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  APPROVAL,
  buildChildArgs,
  checkAnyValue,
  checkValue,
  DEFAULT_AUTO,
  FR4_FORBIDDEN,
  normalizeAutoList,
  resolveRepo,
  runsWithoutApproval,
  templateWords,
  VERB_NAMES,
  VERBS,
} from "../src/brain_train/slack/verbs.mjs"

const REPO = { name: "btrain", path: "/work/btrain", laneIds: ["a", "e"], agents: ["claude", "codex"] }

describe("the verb table", () => {
  it("has exactly the six verbs of FR-3", () => {
    assert.deepEqual([...VERB_NAMES].sort(), ["flush", "pause", "poll-pr", "retry-review", "start", "status"])
  })

  it("names no command of the FR-4 list, as a verb or in any template word", () => {
    for (const word of FR4_FORBIDDEN) assert.ok(!VERB_NAMES.includes(word), word)
    for (const word of templateWords()) {
      const bare = word.replace(/^-+/, "")
      for (const forbidden of FR4_FORBIDDEN) {
        assert.notEqual(bare, forbidden, `template word ${word}`)
        assert.ok(!bare.split("-").includes(forbidden), `template word ${word} holds ${forbidden}`)
      }
    }
  })

  it("gives each verb its approval rule", () => {
    assert.equal(VERBS.start.approval, APPROVAL.REQUIRED)
    assert.equal(VERBS.pause.approval, APPROVAL.TYPED_ONLY)
    for (const name of ["status", "flush", "poll-pr", "retry-review"]) assert.equal(VERBS[name].approval, APPROVAL.AUTO_LIST)
  })

  it("lets every verb take repo= and only start take fields", () => {
    for (const name of VERB_NAMES) assert.equal(VERBS[name].args[0], "repo")
    for (const name of VERB_NAMES.filter((item) => item !== "start")) assert.deepEqual([...VERBS[name].fields], [])
    assert.deepEqual([...VERBS.start.required], ["owner", "task", "files"])
  })
})

describe("buildChildArgs", () => {
  it("builds each verb's argument lists from its template, one value per argument", () => {
    assert.deepEqual(buildChildArgs("status"), [{ argv: ["slack", "refresh"], detached: false }])
    assert.deepEqual(buildChildArgs("flush"), [{ argv: ["slack", "flush"], detached: false }])
    assert.deepEqual(buildChildArgs("poll-pr", { lane: "e" }), [{ argv: ["pr", "poll", "--lane", "e", "--apply"], detached: false }])
    assert.deepEqual(buildChildArgs("retry-review", { lane: "e" }), [{
      argv: ["loop", "--lane", "e", "--max-rounds", "1", "--expect-status", "needs-review"], detached: true,
    }])
    assert.deepEqual(buildChildArgs("pause"), [])
  })

  it("builds start's claim and loop, with the optional flags only when given, and the task as one argument", () => {
    const task = "Add retry; $(rm -rf /) `echo` \"quoted\""
    const [claim, loop] = buildChildArgs("start", {
      lane: "e", owner: "codex", task, files: "src/a.mjs, test/a.test.mjs", objective: "Retry on 429",
      "requested-via": "slack C0000FAKE 1700000000.000100 operator", "max-rounds": "4",
    })
    assert.deepEqual(claim.argv, [
      "handoff", "claim", "--lane", "e", "--owner", "codex", "--task", task, "--files", "src/a.mjs, test/a.test.mjs",
      "--objective", "Retry on 429", "--requested-via", "slack C0000FAKE 1700000000.000100 operator",
    ])
    assert.equal(claim.detached, false)
    assert.deepEqual(loop, { argv: ["loop", "--lane", "e", "--max-rounds", "4"], detached: true })
  })

  it("leaves --lane out in a repository without lanes", () => {
    const [claim, loop] = buildChildArgs("start", { owner: "codex", task: "t", files: "a", "requested-via": "slack x y operator", "max-rounds": "4" })
    assert.ok(!claim.argv.includes("--lane"))
    assert.deepEqual(loop.argv, ["loop", "--max-rounds", "4"])
  })

  it("refuses a value that starts with -, is empty, or holds a control character, and a missing required value", () => {
    assert.throws(() => buildChildArgs("poll-pr", { lane: "--help" }), /may not start with "-"/)
    assert.throws(() => buildChildArgs("start", { owner: "codex", task: "a\nb", files: "a", "requested-via": "x", "max-rounds": "4" }), /control character/)
    assert.throws(() => buildChildArgs("poll-pr", {}), /lane is required/)
    assert.throws(() => buildChildArgs("nope"), /unknown verb/)
  })
})

describe("value checks", () => {
  it("applies the checks that hold for every value", () => {
    assert.equal(checkAnyValue("task", "fine"), "")
    assert.match(checkAnyValue("task", "   "), /empty/)
    assert.match(checkAnyValue("task", "-x"), /may not start with "-"/)
    assert.match(checkAnyValue("task", "a\u0007b"), /control character/)
    assert.match(checkAnyValue("task", "a b"), /line break/)
  })

  it("checks lane, owner, and reviewer against the repository", () => {
    assert.equal(checkValue("lane", "e", REPO), "")
    assert.match(checkValue("lane", "z", REPO), /not a lane/)
    assert.equal(checkValue("owner", "codex", REPO), "")
    assert.match(checkValue("reviewer", "nobody", REPO), /not an active agent/)
  })

  it("limits task to 2,000 characters and the packet fields to 500", () => {
    assert.equal(checkValue("task", "t".repeat(2000), REPO), "")
    assert.match(checkValue("task", "t".repeat(2001), REPO), /longer than 2000/)
    assert.match(checkValue("done-when", "d".repeat(501), REPO), /longer than 500/)
  })

  it("accepts relative file paths inside the repository and rejects the rest", () => {
    assert.equal(checkValue("files", "README.md, src/x.py", REPO), "")
    for (const [files, reason] of [
      ["../secret", /\.\./],
      ["src/../../x", /\.\./],
      ["/etc/passwd", /not a relative path/],
      ["~/x", /not a relative path/],
      ["src\\x", /backslash/],
      ["a,,b", /empty entry/],
      [Array.from({ length: 51 }, (_, index) => `f${index}`).join(","), /more than 50/],
    ]) {
      assert.match(checkValue("files", files, REPO), reason, files)
    }
  })

  it("rejects an unknown key", () => {
    assert.match(checkValue("colour", "x", REPO), /unknown key/)
  })
})

describe("resolveRepo", () => {
  const twoNamed = [{ name: "web", path: "/a/web" }, { name: "web", path: "/b/web" }, { name: "api", path: "/a/api" }]

  it("needs no repo= in a channel with one repository", () => {
    assert.equal(resolveRepo(undefined, [REPO]).repo, REPO)
  })

  it("requires repo= with several repositories, accepts a unique name or a registered path, and rejects the rest", () => {
    assert.match(resolveRepo(undefined, twoNamed).reason, /more than one repository/)
    assert.equal(resolveRepo("api", twoNamed).repo.path, "/a/api")
    assert.match(resolveRepo("web", twoNamed).reason, /more than one repository here is named web/)
    assert.equal(resolveRepo("/b/web", twoNamed).repo.path, "/b/web")
    assert.match(resolveRepo("other", twoNamed).reason, /not a repository served in this channel/)
    assert.match(resolveRepo("x", []).reason, /serves no repository/)
  })
})

describe("the auto list", () => {
  it("defaults to the four verbs of FR-3", () => {
    assert.deepEqual([...DEFAULT_AUTO], ["status", "flush", "poll-pr", "retry-review"])
    assert.deepEqual(normalizeAutoList(undefined), { auto: [...DEFAULT_AUTO], errors: [] })
  })

  it("refuses start and pause, drops unknown verbs, and reports each", () => {
    const { auto, errors } = normalizeAutoList(["status", "start", "pause", "merge", "status"])
    assert.deepEqual(auto, ["status"])
    assert.equal(errors.length, 3)
    assert.match(errors.join("\n"), /may not hold start/)
    assert.match(errors.join("\n"), /may not hold pause/)
    assert.match(errors.join("\n"), /unknown verb: merge/)
    assert.match(normalizeAutoList("status").errors[0], /must be a list/)
  })

  it("runs a proposal without approval only for an auto-list verb on the list", () => {
    assert.equal(runsWithoutApproval("retry-review"), true)
    assert.equal(runsWithoutApproval("retry-review", ["status"]), false)
    assert.equal(runsWithoutApproval("start", ["start"]), false)
    assert.equal(runsWithoutApproval("pause", ["pause"]), false)
  })
})

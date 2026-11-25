// Spec 024 FR-1, FR-14, FR-15, FR-16 through src/brain_train/slack/config.mjs
// (plan WS2, T009), and spec 025's listener settings (T012).
import { describe, it, after } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  channelForRepo,
  developerLabel,
  getListenerSettings,
  getRepoOrchestratorOptions,
  getSlackOptions,
  isSlackEnabled,
  isSlackListenEnabled,
  ORCHESTRATOR_DEFAULTS,
  servedRepositories,
  listChannels,
  mentionList,
  operatorId,
  SLACK_DEFAULTS,
} from "../src/brain_train/slack/config.mjs"

const roots = []
after(async () => Promise.all(roots.map((root) => fs.rm(root, { recursive: true, force: true }))))

describe("the toggle (FR-1)", () => {
  it("is on only when [features].slack is exactly true", () => {
    assert.equal(isSlackEnabled({ features: { slack: true } }), true)
    // The project TOML parser keeps a comment after an unquoted value.
    assert.equal(isSlackEnabled({ features: { slack: "true # on" } }), true)
    assert.equal(isSlackEnabled({ features: { slack: "false # off" } }), false)
    for (const config of [{}, null, { features: {} }, { features: { slack: false } }, { features: { slack: "true" } }, { features: { slack: "1" } }]) {
      assert.equal(isSlackEnabled(config), false, JSON.stringify(config))
    }
  })
})

describe("[slack] options", () => {
  it("applies the defaults and reads values the TOML parser returns as strings", () => {
    assert.deepEqual(getSlackOptions({}), { ...SLACK_DEFAULTS, errors: [] })
    assert.deepEqual(getSlackOptions({ slack: { task_chars: "120", summary_chars: "80  # shorter", inline_timeout_ms: "1500" } }), {
      taskChars: 120,
      summaryChars: 80,
      inlineTimeoutMs: 1500,
      errors: [],
    })
  })

  it("uses the default and reports an error for a value that does not parse", () => {
    const options = getSlackOptions({ slack: { task_chars: "0", inline_timeout_ms: "soon" } })
    assert.equal(options.taskChars, 300)
    assert.equal(options.inlineTimeoutMs, 2000)
    assert.deepEqual(options.errors.map((error) => error.key), ["slack.task_chars", "slack.inline_timeout_ms"])
  })
})

describe("channel for a repository (FR-16)", () => {
  it("maps two registered repositories with one name to their own channels by path", async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "btrain-slack-config-")))
    roots.push(root)
    const first = path.join(root, "one", "shop-web")
    const second = path.join(root, "two", "shop-web")
    await fs.mkdir(first, { recursive: true })
    await fs.mkdir(second, { recursive: true })
    const settings = { channels: { [first]: "C0000AAAA", [second]: "C0000BBBB" }, defaultChannel: "C0000DEFT" }
    assert.deepEqual(channelForRepo(settings, first), { channel: "C0000AAAA", source: "mapped" })
    assert.deepEqual(channelForRepo(settings, second), { channel: "C0000BBBB", source: "mapped" })
    assert.deepEqual(channelForRepo(settings, path.join(first, "..", "shop-web")), { channel: "C0000AAAA", source: "mapped" })
  })

  it("finds a repository reached through a symlink by its real path", async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "btrain-slack-config-")))
    roots.push(root)
    const real = path.join(root, "repo")
    await fs.mkdir(real)
    await fs.symlink(real, path.join(root, "link"))
    assert.equal(channelForRepo({ channels: { [real]: "C0000AAAA" } }, path.join(root, "link")).channel, "C0000AAAA")
  })

  it("uses defaultChannel for an unmapped repository, and none when that is unset or not a channel ID", () => {
    assert.deepEqual(channelForRepo({ channels: {}, defaultChannel: "C0000DEFT" }, "/elsewhere"), { channel: "C0000DEFT", source: "default" })
    assert.deepEqual(channelForRepo({}, "/elsewhere"), { channel: "", source: "" })
    assert.deepEqual(channelForRepo({ defaultChannel: "#general" }, "/elsewhere"), { channel: "", source: "" })
    assert.deepEqual(channelForRepo({ channels: { "/r": "not-a-channel" } }, "/r"), { channel: "", source: "" })
  })

  it("ignores a relative key, which would match against the current directory", () => {
    assert.deepEqual(channelForRepo({ channels: { ".": "C0000AAAA", btrain: "C0000BBBB" } }, process.cwd()), { channel: "", source: "" })
  })

  it("lists the channel map with the repositories each channel carries", () => {
    assert.deepEqual(listChannels({ channels: { "/b": "C0000AAAA", "/a": "C0000AAAA", "/c": "C0000BBBB", "/d": "bad" } }), [
      { channel: "C0000AAAA", repos: ["/a", "/b"] },
      { channel: "C0000BBBB", repos: ["/c"] },
    ])
  })
})

describe("label, mentions, operator (FR-14, FR-15)", () => {
  it("uses the configured label, else the OS user name", () => {
    assert.equal(developerLabel({ label: " brian " }), "brian")
    assert.equal(developerLabel({}), os.userInfo().username)
  })

  it("keeps only well-formed user IDs, once each", () => {
    assert.deepEqual(mentionList({ mention: ["U0000FAKE", "U0000FAKE", "<!channel>", "W0000FAKE", 7] }), ["U0000FAKE", "W0000FAKE"])
    assert.deepEqual(mentionList({}), [])
    assert.equal(operatorId({ operator: "U0000FAKE" }), "U0000FAKE")
    assert.equal(operatorId({ operator: "@brian" }), "")
  })
})

// Spec 025 FR-1 and the plan's WS2 (T012): the listener's settings.
describe("the slack_listen toggle (spec 025 FR-1)", () => {
  it("is on only when [features].slack_listen is exactly true, apart from slack", () => {
    assert.equal(isSlackListenEnabled({ features: { slack_listen: true } }), true)
    assert.equal(isSlackListenEnabled({ features: { slack_listen: "true # on" } }), true)
    for (const config of [{}, null, { features: {} }, { features: { slack: true } }, { features: { slack_listen: "true" } }, { features: { slack_listen: false } }]) {
      assert.equal(isSlackListenEnabled(config), false, JSON.stringify(config))
    }
    assert.equal(isSlackEnabled({ features: { slack_listen: true } }), false, "listening does not turn publishing on")
  })
})

describe("the orchestrator settings in slack.json (spec 025)", () => {
  it("applies the spec's defaults", () => {
    assert.deepEqual(getListenerSettings({}), {
      operator: "",
      pollSeconds: 10,
      orchestrator: { ...ORCHESTRATOR_DEFAULTS, model: true },
      errors: [],
    })
    assert.deepEqual(ORCHESTRATOR_DEFAULTS, { runner: "claude -p", turnSeconds: 180, maxTurnsPerHour: 30, approvalMinutes: 15, conversationMinutes: 30 })
  })

  it("reads every value and the operator", () => {
    const settings = getListenerSettings({
      operator: " U0000FAKE ",
      pollSeconds: 5,
      orchestrator: { runner: "claude -p --model opus", turnSeconds: 60, maxTurnsPerHour: 10, approvalMinutes: 5, conversationMinutes: 20 },
    })
    assert.deepEqual(settings, {
      operator: "U0000FAKE",
      pollSeconds: 5,
      orchestrator: { runner: "claude -p --model opus", model: true, turnSeconds: 60, maxTurnsPerHour: 10, approvalMinutes: 5, conversationMinutes: 20 },
      errors: [],
    })
  })

  it("turns the model off with an empty runner, and keeps commands", () => {
    for (const runner of ["", "   "]) {
      const { orchestrator, errors } = getListenerSettings({ orchestrator: { runner } })
      assert.deepEqual([orchestrator.runner, orchestrator.model, errors], ["", false, []])
    }
  })

  it("takes the default and reports an error for a value that does not parse", () => {
    const { pollSeconds, orchestrator, errors, operator } = getListenerSettings({
      operator: "not-a-user",
      pollSeconds: 0,
      orchestrator: { runner: 7, turnSeconds: "180", maxTurnsPerHour: -1, approvalMinutes: 1.5, conversationMinutes: null },
    })
    assert.equal(operator, "", "a malformed operator counts as none: the listener refuses to start")
    assert.equal(pollSeconds, 10)
    assert.deepEqual(orchestrator, { ...ORCHESTRATOR_DEFAULTS, model: true })
    assert.deepEqual(errors.map((error) => error.key).sort(), [
      "orchestrator.approvalMinutes", "orchestrator.conversationMinutes", "orchestrator.maxTurnsPerHour",
      "orchestrator.runner", "orchestrator.turnSeconds", "pollSeconds",
    ])
    assert.equal(getListenerSettings({ orchestrator: "claude" }).errors[0].key, "orchestrator")
  })
})

describe("[slack.orchestrator] in project.toml (spec 025)", () => {
  it("applies the spec's starting values", () => {
    assert.deepEqual(getRepoOrchestratorOptions({}), {
      auto: ["status", "flush", "poll-pr", "retry-review"],
      maxActive: 3, maxRounds: 4, maxCommandsPerHour: 20, retryReviewPerHour: 3, errors: [],
    })
  })

  it("reads values the TOML parser returns as strings, with comments", () => {
    const options = getRepoOrchestratorOptions({ slack: { orchestrator: {
      auto: '["status", "flush"] # fewer', max_active: "2", max_rounds: "6 # more", max_commands_per_hour: "10", retry_review_per_hour: "1",
    } } })
    assert.deepEqual(options, { auto: ["status", "flush"], maxActive: 2, maxRounds: 6, maxCommandsPerHour: 10, retryReviewPerHour: 1, errors: [] })
    assert.deepEqual(getRepoOrchestratorOptions({ slack: { orchestrator: { auto: [] } } }).auto, [], "an empty list makes every proposal wait for approval")
  })

  it("refuses a whole number too large to hold exactly (codex-reviewer M16)", () => {
    const options = getRepoOrchestratorOptions({ slack: { orchestrator: { max_rounds: "9007199254740993", max_active: "9007199254740991" } } })
    assert.equal(options.maxRounds, 4, "an unsafe integer takes the default")
    assert.equal(options.maxActive, 9007199254740991, "the largest safe integer is kept")
    assert.deepEqual(options.errors.map((error) => error.key), ["slack.orchestrator.max_rounds"])
  })

  it("refuses start and pause in auto, drops unknown verbs, and reports each", () => {
    const options = getRepoOrchestratorOptions({ slack: { orchestrator: { auto: ["status", "start", "pause", "merge", "status"], max_rounds: "zero" } } })
    assert.deepEqual(options.auto, ["status"])
    assert.equal(options.maxRounds, 4)
    assert.equal(options.errors.length, 4)
    assert.ok(options.errors.every((error) => typeof error.message === "string" && error.key.startsWith("slack.orchestrator.")))
  })
})

describe("served repositories (spec 025 FR-1)", () => {
  const on = { features: { slack: true, slack_listen: true } }
  const settings = { channels: { "/work/api": "C0000FAKE", "/work/web": "C0000FAKE", "/work/docs": "C0001FAKE" }, defaultChannel: "C0002FAKE" }

  it("serves a registered repository with both toggles on and a channel", () => {
    const served = servedRepositories([
      { path: "/work/api", name: "api", config: on },
      { path: "/work/web", name: "web", config: { features: { slack: true } } },
      { path: "/work/docs", name: "docs", config: { features: { slack_listen: true } } },
      { path: "/work/misc", name: "misc", config: on },
      { path: "/work/none", name: "none", config: {} },
    ], settings)
    assert.deepEqual(served.map(({ path: repoPath, name, channel, source }) => ({ repoPath, name, channel, source })), [
      { repoPath: "/work/api", name: "api", channel: "C0000FAKE", source: "mapped" },
      { repoPath: "/work/misc", name: "misc", channel: "C0002FAKE", source: "default" },
    ])
    assert.deepEqual(served[0].options, getRepoOrchestratorOptions(on))
  })

  it("carries each served repository's own [slack.orchestrator] options (codex-reviewer M15)", () => {
    const own = { ...on, slack: { orchestrator: { auto: [], max_active: "2", retry_review_per_hour: "1 # rarely" } } }
    const [served] = servedRepositories([{ path: "/work/api", name: "api", config: own }], settings)
    assert.deepEqual(served.options.auto, [], "an empty auto list is kept, not replaced by the default")
    assert.equal(served.options.maxActive, 2)
    assert.equal(served.options.retryReviewPerHour, 1)
  })

  it("serves nothing without a channel from the map or the catch-all", () => {
    assert.deepEqual(servedRepositories([{ path: "/work/misc", name: "misc", config: on }], { channels: {} }), [])
    assert.deepEqual(servedRepositories(undefined, settings), [])
    assert.deepEqual(servedRepositories([null, { name: "no-path", config: on }], settings), [])
  })
})

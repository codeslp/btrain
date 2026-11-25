// Spec 024 FR-1, FR-14, FR-15, FR-16 through src/brain_train/slack/config.mjs
// (plan WS2, T009).
import { describe, it, after } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  channelForRepo,
  developerLabel,
  getSlackOptions,
  isSlackEnabled,
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

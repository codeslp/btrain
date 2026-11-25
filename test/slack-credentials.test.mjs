// Spec 024 FR-2 through src/brain_train/slack/credentials.mjs (plan WS2, T008).
// Every test points BRAIN_TRAIN_HOME at a temporary directory, so the real
// ~/.btrain/slack.json is never read.
import { describe, it, after } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { btrainHome, CREDENTIAL_REASONS, loadSlackCredentials, readSlackFile, slackFilePath, TOKEN_ENV } from "../src/brain_train/slack/credentials.mjs"

const FILE_BOT = ["xoxb", "0000", "fake", "file"].join("-")
const ENV_BOT = ["xoxb", "0000", "fake", "env"].join("-")

const roots = []
after(async () => Promise.all(roots.map((root) => fs.rm(root, { recursive: true, force: true }))))

async function home(content, { mode = 0o600 } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "btrain-slack-cred-"))
  roots.push(root)
  const env = { BRAIN_TRAIN_HOME: root }
  if (content !== undefined) {
    await fs.writeFile(slackFilePath(env), typeof content === "string" ? content : JSON.stringify(content), { mode })
    await fs.chmod(slackFilePath(env), mode)
  }
  return env
}

function assertNoToken(result) {
  const text = JSON.stringify({ ...result, token: undefined })
  assert.ok(!text.includes(FILE_BOT) && !text.includes(ENV_BOT), "no field but token holds the token")
}

describe("slack credentials", () => {
  it("resolves the home from BRAIN_TRAIN_HOME", () => {
    assert.equal(btrainHome({ BRAIN_TRAIN_HOME: "/tmp/x" }), path.resolve("/tmp/x"))
    assert.equal(slackFilePath({ BRAIN_TRAIN_HOME: "/tmp/x" }), path.resolve("/tmp/x/slack.json"))
  })

  it("reads the token and settings from a private file", async () => {
    const env = await home({ botToken: FILE_BOT, label: "dev", channels: { "/r": "C0000FAKE" } })
    const result = await loadSlackCredentials({ env })
    assert.deepEqual(result, { token: FILE_BOT, source: "file", reason: "", settings: { label: "dev", channels: { "/r": "C0000FAKE" } } })
  })

  it("prefers the environment variable over the file's token", async () => {
    const env = { ...(await home({ botToken: FILE_BOT, label: "dev" })), [TOKEN_ENV]: ENV_BOT }
    const result = await loadSlackCredentials({ env })
    assert.equal(result.token, ENV_BOT)
    assert.equal(result.source, "env")
    assert.equal(result.settings.label, "dev")
  })

  it("reports a missing token when there is no file and no variable", async () => {
    const result = await loadSlackCredentials({ env: await home() })
    assert.deepEqual(result, { token: "", source: "", reason: CREDENTIAL_REASONS.MISSING, settings: {} })
    assert.equal((await loadSlackCredentials({ env: await home({ label: "dev" }) })).reason, CREDENTIAL_REASONS.MISSING)
  })

  it("rejects a file readable by group or other as insecure, even with the variable set", async () => {
    for (const mode of [0o640, 0o604, 0o644]) {
      const env = { ...(await home({ botToken: FILE_BOT }, { mode })), [TOKEN_ENV]: ENV_BOT }
      const result = await loadSlackCredentials({ env })
      assert.deepEqual([result.token, result.reason], ["", CREDENTIAL_REASONS.INSECURE], mode.toString(8))
      assertNoToken(result)
    }
  })

  it("rejects a file owned by another user as insecure", async () => {
    const env = await home({ botToken: FILE_BOT })
    const result = await readSlackFile({ env, getuid: () => -1 })
    assert.equal(result.reason, CREDENTIAL_REASONS.INSECURE)
  })

  it("skips the owner and mode checks on Windows", async () => {
    const env = await home({ botToken: FILE_BOT }, { mode: 0o644 })
    const result = await readSlackFile({ env, platform: "win32", getuid: () => -1 })
    assert.equal(result.reason, "")
  })

  it("rejects a symlink, an oversized file, a file that is not JSON, and JSON that is not an object", async () => {
    const target = await home({ botToken: FILE_BOT })
    const linked = await home()
    await fs.symlink(slackFilePath(target), slackFilePath(linked))
    const cases = [
      ["symlink", linked],
      ["oversized", await home({ botToken: FILE_BOT, pad: "x".repeat(5000) })],
      ["not JSON", await home("{botToken: x")],
      ["array", await home("[1,2]")],
      ["null", await home("null")],
    ]
    for (const [name, env] of cases) {
      const result = await loadSlackCredentials({ env })
      assert.deepEqual([result.token, result.reason], ["", CREDENTIAL_REASONS.INVALID], name)
      assertNoToken(result)
    }
  })

  it("rejects a directory where the file should be", async () => {
    const env = await home()
    await fs.mkdir(slackFilePath(env))
    assert.equal((await readSlackFile({ env })).reason, CREDENTIAL_REASONS.INVALID)
  })
})

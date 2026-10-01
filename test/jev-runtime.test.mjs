import { describe, it } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import http from "node:http"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { fileURLToPath } from "node:url"
import { loadSystemOneRuntimeConfig } from "../src/brain_train/system-one.mjs"

const exec = promisify(execFile)
const cli = fileURLToPath(new URL("../src/brain_train/cli.mjs", import.meta.url))
const testKey = "fixture-private-jev-credential"

async function privateCredentials(root, value = { apiKey: testKey }) {
  const file = path.join(root, "jev.json")
  await fs.writeFile(file, JSON.stringify(value), { mode: 0o600 })
  return file
}

describe("Jev user credentials", () => {
  it("loads a private user credential in default assist without exposing it in a reason", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "jev-config-"))
    try {
      await privateCredentials(root)
      const active = await loadSystemOneRuntimeConfig({ BRAIN_TRAIN_HOME: root })
      assert.equal(active.enabled, true)
      assert.equal(active.mode, "assist")
      assert.equal(active.apiKey, testKey)
      assert.equal(active.reason, "enabled")
      const override = await loadSystemOneRuntimeConfig({ BRAIN_TRAIN_HOME: root, JEV_API_KEY: "environment-key" })
      assert.equal(override.apiKey, "environment-key")
      await fs.writeFile(path.join(root, "jev.json"), "malformed credential file")
      assert.equal((await loadSystemOneRuntimeConfig({ BRAIN_TRAIN_HOME: root, BTRAIN_JEV_MODE: "off" })).reason, "mode-off")
      assert.equal((await loadSystemOneRuntimeConfig({ BRAIN_TRAIN_HOME: root, BTRAIN_JEV_MODE: "typo" })).reason, "invalid-mode")
    } finally { await fs.rm(root, { recursive: true, force: true }) }
  })

  it("rejects insecure symlink malformed and oversized credentials without breaking the PR path", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "jev-credential-reject-"))
    const env = { BRAIN_TRAIN_HOME: root }
    try {
      assert.equal((await loadSystemOneRuntimeConfig(env)).reason, "missing-api-key")
      const file = await privateCredentials(root)
      if (process.platform !== "win32") {
        await fs.chmod(file, 0o644)
        assert.equal((await loadSystemOneRuntimeConfig(env)).reason, "insecure-credential-file")
        await fs.chmod(file, 0o600)
        const link = path.join(root, "linked.json")
        await fs.symlink(file, link)
        assert.equal((await loadSystemOneRuntimeConfig({ ...env, BTRAIN_JEV_CREDENTIALS_FILE: link })).reason, "invalid-credential-file")
      }
      for (const contents of ["not-json", JSON.stringify({ apiKey: [testKey] }), JSON.stringify({ apiKey: "" }), "x".repeat(4097)]) {
        await fs.writeFile(file, contents)
        const invalid = await loadSystemOneRuntimeConfig(env)
        assert.equal(invalid.enabled, false)
        assert.equal(invalid.apiKey, "")
        assert.equal(invalid.reason, "invalid-credential-file")
        assert.equal(invalid.reason.includes(testKey), false)
      }
      assert.equal((await loadSystemOneRuntimeConfig({ ...env, BTRAIN_JEV_CREDENTIALS_FILE: root })).reason, "invalid-credential-file")
    } finally { await fs.rm(root, { recursive: true, force: true }) }
  })
})

function reply(choice = "feedback") {
  return { model: "fixture-model", answers: {
    signal: { choice, confidence: 0.97, probabilities: Object.fromEntries(["clear", "feedback", "unavailable", "uncertain"].map((name) => [name, name === choice ? 0.97 : 0.01])) },
    hasVerdict: { noul: 0.98 },
  } }
}

describe("default Jev through the real btrain PR CLI", () => {
  it("uses user credentials without a mode flag, adds feedback only, and preserves off/failure behavior", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "jev-cli-composition-"))
    const home = path.join(root, "user-home")
    const bin = path.join(root, "bin")
    const calls = []
    let answer = reply()
    let statusCode = 200
    const server = http.createServer(async (request, response) => {
      let body = ""
      for await (const chunk of request) body += chunk
      calls.push({ body: JSON.parse(body), authorization: request.headers.authorization })
      response.writeHead(statusCode, { "content-type": "application/json" })
      response.end(JSON.stringify(answer))
    })
    try {
      await fs.mkdir(home)
      await fs.mkdir(bin)
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
      const env = { ...process.env, BRAIN_TRAIN_HOME: home, BTRAIN_AGENT: "codex",
        BTRAIN_JEV_ENDPOINT: `http://127.0.0.1:${server.address().port}/systemone`, BTRAIN_JEV_MODEL: "fixture-model" }
      for (const field of ["BTRAIN_JEV_API_KEY", "JEV_API_KEY", "TYPESAFE_API_KEY", "BTRAIN_JEV_MODE", "BTRAIN_JEV_CREDENTIALS_FILE", "BTRAIN_LANE", "BTRAIN_LANE_LOCKED", "BTRAIN_REPO", "BTRAIN_LOOP_ACTIVE"]) delete env[field]
      await exec(process.execPath, [cli, "init", root, "--core-only", "--agent", "codex", "--agent", "codex-reviewer", "--lanes-per-agent", "1"], { env })
      const configPath = path.join(root, ".btrain", "project.toml")
      await fs.writeFile(configPath, (await fs.readFile(configPath, "utf8")).replace(/required_bots = \[[^\n]*\]/, 'required_bots = ["codex"]'))
      await privateCredentials(home)
      const head = "a".repeat(40)
      const comment = { id: 100, user: { login: "chatgpt-codex-connector[bot]" }, created_at: "2026-10-01T12:00:00Z",
        body: `The cleanup routine finishes while the task is still holding its resources.\n\n**Reviewed commit:** \`${head}\``,
        html_url: "https://github.com/o/r/pull/12#issuecomment-100" }
      const pr = { number: 12, title: "Fixture PR", url: "https://github.com/o/r/pull/12", state: "OPEN", headRefOid: head, headRefName: "fixture", baseRefName: "main" }
      const fakeGh = `#!${process.execPath}\nconst args=process.argv.slice(2);\nif(args[0]==="--version") console.log("gh fixture");\nelse if(args[0]==="repo") console.log("o/r");\nelse if(args[0]==="pr") console.log(${JSON.stringify(JSON.stringify(pr))});\nelse if(args[0]==="api") console.log(JSON.stringify(args[1].endsWith("/issues/12/comments")?${JSON.stringify([comment])}:[]));\n`
      await fs.writeFile(path.join(bin, "gh"), fakeGh, { mode: 0o755 })
      env.PATH = `${bin}${path.delimiter}${process.env.PATH}`
      const run = async (extra = {}) => {
        const { stdout, stderr } = await exec(process.execPath, [cli, "pr", "status", "--lane", "a", "--pr", "12", "--format", "json"], { cwd: root, env: { ...env, ...extra } })
        assert.equal((stdout + stderr).includes(testKey), false)
        return JSON.parse(stdout)
      }
      const active = await run()
      assert.equal(active.semantic.mode, "assist")
      assert.equal(active.semantic.enabled, true)
      assert.equal(active.semantic.appliedCount, 1)
      assert.equal(active.overall, "feedback")
      assert.equal(calls.length, 1)
      assert.equal(calls[0].authorization, `Bearer ${testKey}`)
      assert.deepEqual(Object.keys(calls[0].body.state), ["reviewComment"])
      assert.equal(calls[0].body.model, "fixture-model")

      answer = reply("clear")
      const clear = await run()
      assert.equal(clear.overall, "waiting")
      assert.equal(clear.semantic.appliedCount, 0)
      const beforeOff = calls.length
      assert.equal((await run({ BTRAIN_JEV_MODE: "off" })).semantic, undefined)
      assert.equal(calls.length, beforeOff)

      answer = reply()
      const shadow = await run({ BTRAIN_JEV_MODE: "shadow" })
      assert.equal(shadow.overall, "waiting")
      assert.equal(shadow.semantic.appliedCount, 0)
      statusCode = 503
      const failure = await run()
      assert.equal(failure.overall, "waiting")
      assert.equal(failure.semantic.decisions[0].outcome, "provider-failure")
      statusCode = 200
      answer = { answers: { signal: { choice: "feedback" } } }
      const malformed = await run()
      assert.equal(malformed.overall, "waiting")
      assert.equal(malformed.semantic.decisions[0].outcome, "invalid-answer")
      await fs.unlink(path.join(home, "jev.json"))
      const missing = await run()
      assert.equal(missing.semantic.enabled, false)
      assert.equal(missing.semantic.reason, "missing-api-key")
    } finally {
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})

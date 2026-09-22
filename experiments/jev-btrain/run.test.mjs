import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"

for (const stall of ["fetch", "body"]) {
  test(`runner saves uncertain results when ${stall} stalls`, async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jev-deadline-"))
    try {
      await fs.copyFile(new URL("./run.mjs", import.meta.url), path.join(dir, "run.mjs"))
      for (const name of ["pr-signals.json", "handoff-packets.json"]) {
        const fixtures = JSON.parse(await fs.readFile(new URL(`./${name}`, import.meta.url), "utf8"))
        await fs.writeFile(path.join(dir, name), JSON.stringify(fixtures.slice(0, 1)))
      }
      const stub = path.join(dir, "fetch-stub.mjs")
      await fs.writeFile(stub, `globalThis.fetch = async (_url, {signal}) => {
        const live = setInterval(() => {}, 10000);
        signal?.addEventListener('abort', () => clearInterval(live));
        return ${stall === "fetch" ? "new Promise(() => {})" : "{ok:true,json:async () => new Promise(() => {})}"};
      };`)
      const run = spawnSync(process.execPath, ["--import", stub, path.join(dir, "run.mjs")], {
        env: { ...process.env, SYSTEM_ONE_TIMEOUT_MS: "100", RESULT_SLUG: "deadline-test" },
        timeout: 3000,
        encoding: "utf8",
      })
      assert.equal(run.error, undefined, `runner exceeded watchdog: ${run.error}`)
      assert.equal(run.status, 0, run.stderr)
      const result = JSON.parse(await fs.readFile(path.join(dir, "results-deadline-test.json"), "utf8"))
      assert.deepEqual(result.producer, {
        version: "jev-btrain-v1",
        sourceRevision: "working-tree",
        timeoutMs: 100,
      })
      assert.equal(result.timeoutMs, 100)
      for (const experiment of Object.values(result.experiments)) {
        assert.match(experiment.decisionConfigHash, /^[0-9a-f]{64}$/)
        assert.equal(experiment.rows[0].prediction, undefined)
        assert.match(experiment.rows[0].modelError, /timeout.*100 ms/i)
        const summary = experiment.splits.all.model
        assert.equal(summary.count, 0)
        assert.equal(summary.failureCount, 1)
        assert.equal(summary.coverage, 0)
        assert.equal(summary.accuracy, null)
      }
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
}

test("comparison excludes provider failures from classification metrics", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jev-comparison-"))
  try {
    await fs.copyFile(new URL("./compare.mjs", import.meta.url), path.join(dir, "compare.mjs"))
    const experiment = (rows, decisionConfigHash = "config-v1") => ({ model: "test-model", decisionConfigHash, rows })
    const left = {
      experiments: {
        prSignals: experiment([
          { id: "ok", split: "test", label: "clear", prediction: "clear", probabilities: { clear: 1 } },
          { id: "failed", split: "test", label: "feedback", modelError: "timeout" },
          { id: "null", split: "test", label: "feedback", prediction: null },
          { id: "unknown", split: "test", label: "feedback", prediction: "other" },
          { id: "mismatch", split: "test", label: "feedback", prediction: "feedback", text: "old fixture" },
          { id: "absent-class", split: "test", label: "clear", prediction: "uncertain" },
          { id: "left-only", split: "test", label: "feedback", prediction: "feedback" },
        ]),
        handoffPackets: experiment([
          { id: "same", split: "test", label: "accept", prediction: "accept" },
        ]),
      },
    }
    const right = {
      experiments: {
        prSignals: experiment([
          { id: "ok", split: "test", label: "clear", prediction: "clear", probabilities: { clear: 1 } },
          { id: "failed", split: "test", label: "feedback", prediction: "feedback", probabilities: { feedback: 1 } },
          { id: "null", split: "test", label: "feedback", prediction: "feedback" },
          { id: "unknown", split: "test", label: "feedback", prediction: "feedback" },
          { id: "mismatch", split: "train", label: "clear", prediction: "clear", text: "new fixture" },
          { id: "absent-class", split: "test", label: "clear", prediction: "uncertain" },
          { id: "right-only", split: "test", label: "feedback", prediction: "feedback" },
        ]),
        handoffPackets: experiment([
          { id: "same", split: "test", label: "accept", prediction: "accept" },
        ], "config-v2"),
      },
    }
    await fs.writeFile(path.join(dir, "left.json"), JSON.stringify(left))
    await fs.writeFile(path.join(dir, "right.json"), JSON.stringify(right))
    const run = spawnSync(process.execPath, [path.join(dir, "compare.mjs"), "left.json", "right.json"], {
      env: { ...process.env, COMPARISON_SLUG: "test" },
      encoding: "utf8",
    })
    assert.equal(run.status, 0, run.stderr)
    const result = JSON.parse(await fs.readFile(path.join(dir, "comparison-test.json"), "utf8"))
    assert.equal(result.prSignals.test.count, 2)
    assert.equal(result.prSignals.test.excludedFailureCount, 3)
    assert.equal(result.prSignals.test.mismatchCount, 1)
    assert.equal(result.prSignals.test.missingCount, 2)
    assert.equal(result.prSignals.test.coverage, 0.25)
    assert.equal(result.prSignals.test.leftAccuracy, 0.5)
    assert.equal(result.prSignals.test.rightAccuracy, 0.5)
    assert.equal(result.handoffPackets.configurationMismatch, true)
    assert.equal(result.handoffPackets.test.count, 0)
    assert.equal(result.handoffPackets.test.coverage, 0)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("decision config hashes include classifier transformations", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jev-config-hash-"))
  try {
    const source = await fs.readFile(new URL("./run.mjs", import.meta.url), "utf8")
    const originalPath = path.join(dir, "original.mjs")
    const changedPath = path.join(dir, "changed.mjs")
    await fs.writeFile(originalPath, source)
    await fs.writeFile(changedPath, source.replace(
      "{ reviewComment: item.text }",
      "{ reviewBody: item.text }",
    ))
    const readHashes = (target) => {
      const run = spawnSync(process.execPath, [target, "--print-config-hashes"], { encoding: "utf8" })
      assert.equal(run.status, 0, run.stderr)
      return JSON.parse(run.stdout)
    }
    const original = readHashes(originalPath)
    const changed = readHashes(changedPath)

    assert.notEqual(changed.prSignals, original.prSignals)
    assert.equal(changed.handoffPackets, original.handoffPackets)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

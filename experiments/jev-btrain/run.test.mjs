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

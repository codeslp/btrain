import { describe, it } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  BENCHMARK_SCENARIO_CATEGORIES,
  BENCHMARK_SCENARIO_VERSION,
  inspectBenchmarkScenario,
  listBenchmarkScenarios,
  loadBenchmarkRegistry,
  normalizeBenchmarkScenarioId,
} from "../src/brain_train/harness/benchmark-registry.mjs"
import {
  HARNESS_TRACE_FAILURE_CATEGORIES,
  HARNESS_TRACE_OUTCOMES,
} from "../src/brain_train/harness/trace-bundle.mjs"

async function makeTmpRepo() {
  return fs.mkdtemp(path.join(os.tmpdir(), "btrain-benchmark-test-"))
}

async function rmDir(dirPath) {
  await fs.rm(dirPath, { recursive: true, force: true })
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), "utf8")
}

async function writeRaw(filePath, raw) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, raw, "utf8")
}

describe("normalizeBenchmarkScenarioId", () => {
  it("returns null for non-string or empty input", () => {
    assert.equal(normalizeBenchmarkScenarioId(undefined), null)
    assert.equal(normalizeBenchmarkScenarioId(""), null)
    assert.equal(normalizeBenchmarkScenarioId("   "), null)
    assert.equal(normalizeBenchmarkScenarioId(42), null)
  })

  it("lowercases and slug-normalizes valid ids", () => {
    assert.equal(normalizeBenchmarkScenarioId("Writer Lane"), "writer-lane")
    assert.equal(normalizeBenchmarkScenarioId("  Weird__Case!! "), "weird__case")
    assert.equal(normalizeBenchmarkScenarioId("---leading---"), "leading")
  })
})

describe("loadBenchmarkRegistry", () => {
  it("returns bundled scenarios when no repoRoot is provided", async () => {
    const registry = await loadBenchmarkRegistry({})
    assert.equal(registry.version, String(BENCHMARK_SCENARIO_VERSION))
    assert.ok(registry.scenariosDirs.bundled.endsWith("benchmarks"))
    assert.equal(registry.scenariosDirs.repoLocal, "")
    assert.ok(registry.scenarios.length >= 3, "expected at least 3 bundled scenarios")
    assert.deepEqual(registry.categories, [...BENCHMARK_SCENARIO_CATEGORIES])
    assert.deepEqual(registry.outcomes, [...HARNESS_TRACE_OUTCOMES])
    assert.deepEqual(registry.hardFailureCategories, [...HARNESS_TRACE_FAILURE_CATEGORIES])
  })

  it("emits scenarios in deterministic alphabetical order", async () => {
    const registry = await loadBenchmarkRegistry({})
    const ids = registry.scenarios.map((entry) => entry.id)
    const sorted = [...ids].sort((a, b) => a.localeCompare(b))
    assert.deepEqual(ids, sorted)
  })

  it("normalizes unknown categories and outcomes to safe defaults", async () => {
    const tmp = await makeTmpRepo()
    try {
      await writeJson(
        path.join(tmp, ".btrain", "harness", "benchmarks", "odd-scenario.json"),
        {
          id: "odd-scenario",
          category: "not-a-real-category",
          expectedPrimaryOutcome: "exploded",
          hardFailureCategories: ["timeout", "not-a-failure", "routing-error"],
          requiresDiff: "yes-please",
        },
      )
      const registry = await loadBenchmarkRegistry({ repoRoot: tmp })
      const entry = registry.scenarios.find((s) => s.id === "odd-scenario")
      assert.ok(entry, "scenario should have loaded")
      assert.equal(entry.category, "writer-path", "invalid category falls back to writer-path")
      assert.equal(entry.expectedPrimaryOutcome, "pass", "invalid outcome falls back to pass")
      assert.deepEqual(entry.hardFailureCategories, ["routing-error", "timeout"])
      assert.equal(entry.requiresDiff, true, "non-boolean truthy becomes true")
      assert.equal(entry.source, "repo-local")
    } finally {
      await rmDir(tmp)
    }
  })

  it("lets repo-local scenarios override bundled ids with same slug", async () => {
    const tmp = await makeTmpRepo()
    try {
      await writeJson(
        path.join(tmp, ".btrain", "harness", "benchmarks", "writer-lane-discipline.json"),
        {
          id: "writer-lane-discipline",
          category: "repair-needed",
          label: "Repo-local override",
          profileRefs: ["custom"],
          expectedPrimaryOutcome: "fail",
          requiresDiff: false,
        },
      )
      const registry = await loadBenchmarkRegistry({ repoRoot: tmp })
      const entry = registry.scenarios.find((s) => s.id === "writer-lane-discipline")
      assert.ok(entry)
      assert.equal(entry.source, "repo-local")
      assert.equal(entry.label, "Repo-local override")
      assert.equal(entry.category, "repair-needed")
      assert.equal(entry.requiresDiff, false)
      assert.deepEqual(entry.profileRefs, ["custom"])
      assert.ok(
        entry.sourcePath.includes(path.join(".btrain", "harness", "benchmarks")),
        "sourcePath should point at the repo-local file",
      )
    } finally {
      await rmDir(tmp)
    }
  })

  it("raises BtrainError on malformed JSON", async () => {
    const tmp = await makeTmpRepo()
    try {
      await writeRaw(
        path.join(tmp, ".btrain", "harness", "benchmarks", "broken.json"),
        "{ not json",
      )
      await assert.rejects(() => loadBenchmarkRegistry({ repoRoot: tmp }), {
        name: "BtrainError",
        message: /Malformed benchmark scenario JSON/,
      })
    } finally {
      await rmDir(tmp)
    }
  })

  it("raises BtrainError when a scenario has no resolvable id", async () => {
    const tmp = await makeTmpRepo()
    try {
      await writeJson(
        path.join(tmp, ".btrain", "harness", "benchmarks", "---.json"),
        { id: "", label: "Nameless" },
      )
      await assert.rejects(() => loadBenchmarkRegistry({ repoRoot: tmp }), {
        name: "BtrainError",
        message: /missing an id/,
      })
    } finally {
      await rmDir(tmp)
    }
  })

  it("falls back to the filename when the id field is missing", async () => {
    const tmp = await makeTmpRepo()
    try {
      await writeJson(
        path.join(tmp, ".btrain", "harness", "benchmarks", "fallback-id.json"),
        { category: "writer-path", label: "Filename fallback" },
      )
      const registry = await loadBenchmarkRegistry({ repoRoot: tmp })
      const entry = registry.scenarios.find((s) => s.id === "fallback-id")
      assert.ok(entry, "should derive id from filename")
      assert.equal(entry.label, "Filename fallback")
    } finally {
      await rmDir(tmp)
    }
  })
})

describe("listBenchmarkScenarios", () => {
  it("returns all bundled scenarios when no filter is set", async () => {
    const result = await listBenchmarkScenarios({})
    assert.equal(result.filterCategory, "")
    assert.ok(result.scenarios.length >= 3)
  })

  it("filters by category when provided", async () => {
    const result = await listBenchmarkScenarios({ category: "diffless-evidence" })
    assert.equal(result.filterCategory, "diffless-evidence")
    for (const scenario of result.scenarios) {
      assert.equal(scenario.category, "diffless-evidence")
    }
    assert.ok(result.scenarios.length >= 1, "bundled includes diffless-research-evidence")
  })

  it("trims whitespace on the category filter and preserves full list when blank", async () => {
    const blank = await listBenchmarkScenarios({ category: "   " })
    assert.equal(blank.filterCategory, "")
    const all = await listBenchmarkScenarios({})
    assert.equal(blank.scenarios.length, all.scenarios.length)
  })
})

describe("inspectBenchmarkScenario", () => {
  it("returns the scenario detail for a known id", async () => {
    const result = await inspectBenchmarkScenario({ scenarioId: "writer-lane-discipline" })
    assert.ok(result.scenario)
    assert.equal(result.scenario.id, "writer-lane-discipline")
    assert.equal(result.scenario.source, "bundled")
    assert.equal(result.scenario.category, "writer-path")
    assert.deepEqual(result.scenario.profileRefs, ["default"])
  })

  it("throws BtrainError when scenarioId is missing", async () => {
    await assert.rejects(() => inspectBenchmarkScenario({}), {
      name: "BtrainError",
      message: /scenario id is required/i,
    })
  })

  it("throws BtrainError for unknown scenario ids with a helpful fix hint", async () => {
    await assert.rejects(() => inspectBenchmarkScenario({ scenarioId: "no-such-scenario" }), {
      name: "BtrainError",
      message: /Unknown benchmark scenario/,
    })
  })
})

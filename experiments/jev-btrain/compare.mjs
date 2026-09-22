#!/usr/bin/env node

import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.dirname(fileURLToPath(import.meta.url))
const [leftName = "results-kev-0.6b.json", rightName = "results-jev.json"] = process.argv.slice(2)
const left = JSON.parse(await fs.readFile(path.resolve(root, leftName), "utf8"))
const right = JSON.parse(await fs.readFile(path.resolve(root, rightName), "utf8"))

function distributionDistance(a = {}, b = {}) {
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])]
  if (!keys.length) return null
  return keys.reduce((sum, key) => sum + Math.abs((a[key] || 0) - (b[key] || 0)), 0) / keys.length
}

function compareExperiment(leftExperiment, rightExperiment) {
  const rightById = new Map(rightExperiment.rows.map((row) => [row.id, row]))
  const rows = leftExperiment.rows.map((leftRow) => {
    const rightRow = rightById.get(leftRow.id)
    if (!rightRow) return { id: leftRow.id, missing: "right" }
    return {
      id: leftRow.id,
      split: leftRow.split,
      label: leftRow.label,
      left: leftRow.prediction,
      right: rightRow.prediction,
      sameTopChoice: leftRow.prediction === rightRow.prediction,
      leftCorrect: leftRow.prediction === leftRow.label,
      rightCorrect: rightRow.prediction === rightRow.label,
      meanAbsoluteProbabilityDifference: distributionDistance(leftRow.probabilities, rightRow.probabilities),
      leftConfidence: leftRow.confidence,
      rightConfidence: rightRow.confidence,
    }
  })
  const matched = rows.filter((row) => !row.missing)
  const comparable = matched.filter((row) => row.left !== undefined && row.right !== undefined)
  const summarize = (eligible, selected) => {
    const distances = selected
      .map((row) => row.meanAbsoluteProbabilityDifference)
      .filter((value) => value !== null)
    return {
      count: selected.length,
      excludedFailureCount: eligible.length - selected.length,
      coverage: eligible.length ? Number((selected.length / eligible.length).toFixed(3)) : null,
      topChoiceAgreement: selected.length ? Number((selected.filter((row) => row.sameTopChoice).length / selected.length).toFixed(3)) : null,
      leftAccuracy: selected.length ? Number((selected.filter((row) => row.leftCorrect).length / selected.length).toFixed(3)) : null,
      rightAccuracy: selected.length ? Number((selected.filter((row) => row.rightCorrect).length / selected.length).toFixed(3)) : null,
      meanAbsoluteProbabilityDifference: distances.length
        ? Number((distances.reduce((sum, value) => sum + value, 0) / distances.length).toFixed(3))
        : null,
      disagreements: selected.filter((row) => !row.sameTopChoice).map(({ id, label, left: leftPrediction, right: rightPrediction }) => ({ id, label, left: leftPrediction, right: rightPrediction })),
    }
  }
  const matchedTest = matched.filter((row) => row.split === "test")
  const comparableTest = comparable.filter((row) => row.split === "test")
  return { all: summarize(matched, comparable), test: summarize(matchedTest, comparableTest), rows }
}

const comparison = {
  schemaVersion: 1,
  left: { file: leftName, model: left.experiments.prSignals.model },
  right: { file: rightName, model: right.experiments.prSignals.model },
  prSignals: compareExperiment(left.experiments.prSignals, right.experiments.prSignals),
  handoffPackets: compareExperiment(left.experiments.handoffPackets, right.experiments.handoffPackets),
}

const output = path.join(root, `comparison-${process.env.COMPARISON_SLUG || "kev-vs-jev"}.json`)
await fs.writeFile(output, `${JSON.stringify(comparison, null, 2)}\n`)
console.log(JSON.stringify({
  output,
  prSignals: comparison.prSignals.test,
  handoffPackets: comparison.handoffPackets.test,
}, null, 2))

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
  const present = rows.filter((row) => !row.missing)
  const test = present.filter((row) => row.split === "test")
  const summarize = (selected) => ({
    count: selected.length,
    topChoiceAgreement: Number((selected.filter((row) => row.sameTopChoice).length / selected.length).toFixed(3)),
    leftAccuracy: Number((selected.filter((row) => row.leftCorrect).length / selected.length).toFixed(3)),
    rightAccuracy: Number((selected.filter((row) => row.rightCorrect).length / selected.length).toFixed(3)),
    meanAbsoluteProbabilityDifference: Number((selected.reduce((sum, row) => sum + (row.meanAbsoluteProbabilityDifference || 0), 0) / selected.length).toFixed(3)),
    disagreements: selected.filter((row) => !row.sameTopChoice).map(({ id, label, left: leftPrediction, right: rightPrediction }) => ({ id, label, left: leftPrediction, right: rightPrediction })),
  })
  return { all: summarize(present), test: summarize(test), rows }
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

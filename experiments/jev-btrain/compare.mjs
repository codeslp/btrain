#!/usr/bin/env node

import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.dirname(fileURLToPath(import.meta.url))
const [leftName = "results-kev-0.6b.json", rightName = "results-jev.json"] = process.argv.slice(2)
const left = JSON.parse(await fs.readFile(path.resolve(root, leftName), "utf8"))
const right = JSON.parse(await fs.readFile(path.resolve(root, rightName), "utf8"))

function validDistribution(value, labels) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length > 0
    && Object.keys(value).every((key) => labels.includes(key))
    && Object.values(value).every((entry) => Number.isFinite(entry) && entry >= 0 && entry <= 1)
}

function distributionDistance(a, b, labels) {
  if (!validDistribution(a, labels) || !validDistribution(b, labels)) return null
  return labels.reduce((sum, label) => sum + Math.abs((a[label] || 0) - (b[label] || 0)), 0) / labels.length
}

function decisionConfigurationKey(experiment) {
  if (experiment.decisionConfigHash) return `sha256:${experiment.decisionConfigHash}`
  if (experiment.legacyDecisionConfigId) return `legacy:${experiment.legacyDecisionConfigId}`
  return ""
}

function fixtureSignature(row) {
  return JSON.stringify({
    split: row.split,
    label: row.label,
    source: row.source ?? null,
    text: row.text ?? null,
    packet: row.packet ?? null,
  })
}

function compareExperiment(leftExperiment, rightExperiment, labels) {
  const leftById = new Map(leftExperiment.rows.map((row) => [row.id, row]))
  const rightById = new Map(rightExperiment.rows.map((row) => [row.id, row]))
  const allowedLabels = new Set(labels)
  const ids = [...new Set([...leftById.keys(), ...rightById.keys()])]
  const leftConfiguration = decisionConfigurationKey(leftExperiment)
  const rightConfiguration = decisionConfigurationKey(rightExperiment)
  const configurationMismatch = !leftConfiguration || leftConfiguration !== rightConfiguration
  const validPrediction = (row) => row && !row.modelError && allowedLabels.has(row.prediction)
  const invalidIds = new Set(ids.filter((id) => (
    leftById.has(id) && rightById.has(id)
    && (!validPrediction(leftById.get(id)) || !validPrediction(rightById.get(id)))
  )))
  const comparableIds = new Set(ids.filter((id) => (
    !configurationMismatch
    && validPrediction(leftById.get(id))
    && validPrediction(rightById.get(id))
    && fixtureSignature(leftById.get(id)) === fixtureSignature(rightById.get(id))
  )))
  const rows = ids.map((id) => {
    const leftRow = leftById.get(id)
    const rightRow = rightById.get(id)
    if (!leftRow) return { id, split: rightRow.split, label: rightRow.label, missing: "left" }
    if (!rightRow) return { id, split: leftRow.split, label: leftRow.label, missing: "right" }
    if (fixtureSignature(leftRow) !== fixtureSignature(rightRow)) {
      return {
        id,
        split: leftRow.split,
        splits: [...new Set([leftRow.split, rightRow.split])],
        label: leftRow.label,
        mismatch: true,
      }
    }
    return {
      id,
      split: leftRow.split,
      label: leftRow.label,
      left: leftRow.prediction,
      right: rightRow.prediction,
      sameTopChoice: leftRow.prediction === rightRow.prediction,
      leftCorrect: leftRow.prediction === leftRow.label,
      rightCorrect: rightRow.prediction === rightRow.label,
      meanAbsoluteProbabilityDifference: distributionDistance(leftRow.probabilities, rightRow.probabilities, labels),
      leftConfidence: leftRow.confidence,
      rightConfidence: rightRow.confidence,
    }
  })
  const matched = rows.filter((row) => !row.missing)
  const comparable = matched.filter((row) => comparableIds.has(row.id))
  const summarize = (eligible, selected) => {
    const distances = selected
      .map((row) => row.meanAbsoluteProbabilityDifference)
      .filter((value) => value !== null)
    return {
      count: selected.length,
      excludedFailureCount: eligible.filter((row) => invalidIds.has(row.id)).length,
      mismatchCount: eligible.filter((row) => row.mismatch).length,
      missingCount: eligible.filter((row) => row.missing).length,
      coverage: eligible.length ? Number((selected.length / eligible.length).toFixed(3)) : null,
      probabilityCount: distances.length,
      probabilityCoverage: selected.length ? Number((distances.length / selected.length).toFixed(3)) : null,
      topChoiceAgreement: selected.length ? Number((selected.filter((row) => row.sameTopChoice).length / selected.length).toFixed(3)) : null,
      leftAccuracy: selected.length ? Number((selected.filter((row) => row.leftCorrect).length / selected.length).toFixed(3)) : null,
      rightAccuracy: selected.length ? Number((selected.filter((row) => row.rightCorrect).length / selected.length).toFixed(3)) : null,
      meanAbsoluteProbabilityDifference: distances.length
        ? Number((distances.reduce((sum, value) => sum + value, 0) / distances.length).toFixed(3))
        : null,
      disagreements: selected.filter((row) => !row.sameTopChoice).map(({ id, label, left: leftPrediction, right: rightPrediction }) => ({ id, label, left: leftPrediction, right: rightPrediction })),
    }
  }
  const testRows = rows.filter((row) => row.split === "test" || row.splits?.includes("test"))
  const comparableTest = comparable.filter((row) => row.split === "test")
  return { configurationMismatch, all: summarize(rows, comparable), test: summarize(testRows, comparableTest), rows }
}

const comparison = {
  schemaVersion: 1,
  left: { file: leftName, model: left.experiments.prSignals.model },
  right: { file: rightName, model: right.experiments.prSignals.model },
  prSignals: compareExperiment(left.experiments.prSignals, right.experiments.prSignals, ["clear", "feedback", "unavailable", "uncertain"]),
  handoffPackets: compareExperiment(left.experiments.handoffPackets, right.experiments.handoffPackets, ["accept", "repair", "uncertain"]),
}

const output = path.join(root, `comparison-${process.env.COMPARISON_SLUG || "kev-vs-jev"}.json`)
await fs.writeFile(output, `${JSON.stringify(comparison, null, 2)}\n`)
console.log(JSON.stringify({
  output,
  prSignals: comparison.prSignals.test,
  handoffPackets: comparison.handoffPackets.test,
}, null, 2))

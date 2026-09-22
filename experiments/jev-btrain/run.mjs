#!/usr/bin/env node

import fs from "node:fs/promises"
import path from "node:path"
import { performance } from "node:perf_hooks"
import { fileURLToPath } from "node:url"

const root = path.dirname(fileURLToPath(import.meta.url))
const args = new Set(process.argv.slice(2))
const baseUrl = process.env.SYSTEM_ONE_BASE_URL || process.env.KEV_BASE_URL || "http://127.0.0.1:8009"
const apiKey = process.env.SYSTEM_ONE_API_KEY || process.env.JEV_API_KEY || process.env.TYPESAFE_API_KEY || ""
const requestedModel = process.env.SYSTEM_ONE_MODEL || "kev-latest"
const resultSlug = process.env.RESULT_SLUG || (apiKey ? "jev" : "kev-0.6b")
const runModel = !args.has("--baseline-only")
const configuredTimeout = Number(process.env.SYSTEM_ONE_TIMEOUT_MS || 10000)
const timeoutMs = Number.isFinite(configuredTimeout)
  ? Math.min(60000, Math.max(100, configuredTimeout)) : 10000

const PR_LABELS = ["clear", "feedback", "unavailable", "uncertain"]
const HANDOFF_LABELS = ["accept", "repair", "uncertain"]

function regexPrBaseline(text) {
  const value = String(text || "")
  if (/usage limits|something went wrong|unknown error|timed out|quota|authentication failed|\b503\b/i.test(value)) return "unavailable"
  if (/(\d+)\s+issues?\s+found/i.test(value) && !/\b0\s+issues?\s+found/i.test(value)) return "feedback"
  if (/automated review suggestions|P[0-3] Badge|changes requested|blocking/i.test(value)) return "feedback"
  if (/\b0\s+issues?\s+found|no (issues|findings|suggestions)|did(?: not|n't) find any (?:major )?(issues|findings|suggestions)|looks good|approved/i.test(value)) return "clear"
  return "uncertain"
}

function fieldPresenceBaseline(packet) {
  const placeholders = /^(todo|tbd|none|none yet|not run|pending|please review|tests? pass|nothing important|no known gaps)[.!]?$/i
  const values = [packet.objective, packet.changed, packet.verification, packet.gaps, packet.reviewAsk]
  return values.every((value) => String(value || "").trim() && !placeholders.test(String(value).trim())) ? "accept" : "repair"
}

async function postSystemOne(state, questions) {
  const started = performance.now()
  const controller = new AbortController()
  let timer
  try {
    const operation = (async () => {
      const response = await fetch(`${baseUrl}/v1/systemone`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({ state, model: requestedModel, questions }),
        signal: controller.signal,
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(`System One ${response.status}: ${JSON.stringify(body)}`)
      return { body, wallMs: performance.now() - started }
    })()
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error(`System One timeout after ${timeoutMs} ms`)
        reject(error)
        controller.abort(error)
      }, timeoutMs)
    })
    return await Promise.race([operation, deadline])
  } finally {
    clearTimeout(timer)
  }
}

function noulValue(answer) {
  const value = answer?.noul ?? answer?.probability
  if (!Number.isFinite(value)) throw new Error(`Noul response is missing a probability: ${JSON.stringify(answer)}`)
  return value
}

async function classifyPr(item) {
  const { body, wallMs } = await postSystemOne(
    { reviewComment: item.text },
    {
      signal: {
        type: "choice",
        instructions: "What result does this text communicate about the code review?",
        criteria: {
          clear: "The review completed and found no changes or blockers.",
          feedback: "The review found an actionable problem or requests a code or test change.",
          unavailable: "The reviewer failed, timed out, lacked quota or authentication, or did not perform the review.",
          uncertain: "The text is a request, progress update, summary without verdict, author reply, question, or social comment.",
        },
      },
      hasVerdict: {
        type: "noul",
        instructions: "Does the text itself contain a completed code-review verdict: either clear or actionable feedback?",
        criteria: null,
      },
    },
  )
  const answer = body.answers.signal
  const verdictProbability = noulValue(body.answers.hasVerdict)
  const gated = verdictProbability < 0.5 && ["clear", "feedback"].includes(answer.choice) ? "uncertain" : answer.choice
  return {
    servedModel: body.model,
    prediction: gated,
    rawPrediction: answer.choice,
    probabilities: answer.probabilities,
    verdictProbability,
    confidence: answer.confidence,
    wallMs,
    modelMs: body.latency_ms,
    inputTokens: body.usage?.input_tokens,
  }
}

async function classifyHandoff(item) {
  const { body, wallMs } = await postSystemOne(
    { delegationPacket: item.packet },
    {
      quality: {
        type: "choice",
        instructions: "Is this handoff packet ready for a peer reviewer?",
        criteria: {
          accept: "Specific, internally consistent, aligned with the objective, supported by relevant verification, candid about gaps, and gives an actionable review ask.",
          repair: "Vague, contradictory, mismatched to the objective, hides a known failure, claims completion without relevant evidence, or gives no actionable review target.",
          uncertain: "Useful evidence exists but an external result, missing artifact, incomplete reproduction, or unresolved diagnosis prevents a confident accept-or-repair verdict.",
        },
      },
      objectiveAligned: { type: "noul", instructions: "Do the changed files and described change directly advance the stated objective?", criteria: null },
      verificationSupportsClaim: { type: "noul", instructions: "Does the stated verification materially support the completion claim for this objective?", criteria: null },
      gapsAreCandid: { type: "noul", instructions: "Does the gaps field candidly disclose limitations or accurately state that none remain?", criteria: null },
      askIsActionable: { type: "noul", instructions: "Does the review ask tell the reviewer what specific risk, behavior, or evidence to inspect?", criteria: null },
    },
  )
  const answer = body.answers.quality
  return {
    servedModel: body.model,
    prediction: answer.choice,
    probabilities: answer.probabilities,
    confidence: answer.confidence,
    dimensions: {
      objectiveAligned: noulValue(body.answers.objectiveAligned),
      verificationSupportsClaim: noulValue(body.answers.verificationSupportsClaim),
      gapsAreCandid: noulValue(body.answers.gapsAreCandid),
      askIsActionable: noulValue(body.answers.askIsActionable),
    },
    wallMs,
    modelMs: body.latency_ms,
    inputTokens: body.usage?.input_tokens,
  }
}

function perLabelMetrics(rows, labels, predictionKey) {
  const byLabel = {}
  for (const label of labels) {
    const tp = rows.filter((row) => row.label === label && row[predictionKey] === label).length
    const fp = rows.filter((row) => row.label !== label && row[predictionKey] === label).length
    const fn = rows.filter((row) => row.label === label && row[predictionKey] !== label).length
    const precision = tp + fp ? tp / (tp + fp) : 0
    const recall = tp + fn ? tp / (tp + fn) : 0
    byLabel[label] = {
      support: rows.filter((row) => row.label === label).length,
      precision: Number(precision.toFixed(3)),
      recall: Number(recall.toFixed(3)),
      f1: Number((precision + recall ? 2 * precision * recall / (precision + recall) : 0).toFixed(3)),
    }
  }
  return byLabel
}

function summarize(rows, labels, predictionKey) {
  const correct = rows.filter((row) => row.label === row[predictionKey]).length
  const perLabel = perLabelMetrics(rows, labels, predictionKey)
  const f1s = Object.values(perLabel).map((entry) => entry.f1)
  return {
    count: rows.length,
    correct,
    accuracy: Number((correct / rows.length).toFixed(3)),
    macroF1: Number((f1s.reduce((sum, value) => sum + value, 0) / f1s.length).toFixed(3)),
    perLabel,
    errors: rows.filter((row) => row.label !== row[predictionKey]).map((row) => ({
      id: row.id,
      expected: row.label,
      actual: row[predictionKey],
    })),
  }
}

function percentile(values, fraction) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  return Number(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))].toFixed(1))
}

async function runDataset(filename, labels, baseline, modelClassifier) {
  const fixtures = JSON.parse(await fs.readFile(path.join(root, filename), "utf8"))
  const rows = []
  for (const item of fixtures) {
    const row = { ...item, baseline: baseline(item.packet ?? item.text) }
    if (runModel) {
      try {
        Object.assign(row, await modelClassifier(item))
      } catch (error) {
        row.modelError = error.message
        row.prediction = "uncertain"
      }
    }
    rows.push(row)
    process.stderr.write(`\r${filename}: ${rows.length}/${fixtures.length}`)
  }
  process.stderr.write("\n")

  const splits = {}
  for (const split of ["calibration", "test", "all"]) {
    const selected = split === "all" ? rows : rows.filter((row) => row.split === split)
    splits[split] = {
      baseline: summarize(selected, labels, "baseline"),
      ...(runModel ? { model: summarize(selected, labels, "prediction") } : {}),
    }
  }
  const modelRows = rows.filter((row) => Number.isFinite(row.wallMs))
  return {
    fixtures: filename,
    model: runModel ? requestedModel : null,
    servedModels: runModel ? [...new Set(rows.map((row) => row.servedModel).filter(Boolean))] : [],
    splits,
    latency: runModel ? {
      p50WallMs: percentile(modelRows.map((row) => row.wallMs), 0.5),
      p95WallMs: percentile(modelRows.map((row) => row.wallMs), 0.95),
      p50ModelMs: percentile(modelRows.map((row) => row.modelMs).filter(Number.isFinite), 0.5),
      p95ModelMs: percentile(modelRows.map((row) => row.modelMs).filter(Number.isFinite), 0.95),
    } : null,
    rows,
  }
}

const startedAt = new Date().toISOString()
const pr = await runDataset("pr-signals.json", PR_LABELS, regexPrBaseline, classifyPr)
const handoff = await runDataset("handoff-packets.json", HANDOFF_LABELS, fieldPresenceBaseline, classifyHandoff)
const result = {
  schemaVersion: 1,
  producer: {
    version: "jev-btrain-v1",
    sourceRevision: process.env.EXPERIMENT_PRODUCER_REVISION || "working-tree",
    timeoutMs: runModel ? timeoutMs : null,
  },
  startedAt,
  finishedAt: new Date().toISOString(),
  baseUrl: runModel ? baseUrl : null,
  timeoutMs: runModel ? timeoutMs : null,
  caveats: [
    "This is a small frozen pilot, not a production-quality benchmark.",
    "Synthetic paraphrases complement real btrain artifacts and may not match deployment prevalence.",
    "Kev-0.6b is a local Jev-compatible preview model, not hosted Jev.",
    "No model result changes btrain state; all evaluation is non-production and advisory.",
  ],
  experiments: { prSignals: pr, handoffPackets: handoff },
}

const output = path.join(root, runModel ? `results-${resultSlug}.json` : "results-baseline.json")
await fs.writeFile(output, `${JSON.stringify(result, null, 2)}\n`)
console.log(JSON.stringify({
  output,
  pr: pr.splits.test,
  handoff: handoff.splits.test,
  latency: { pr: pr.latency, handoff: handoff.latency },
}, null, 2))

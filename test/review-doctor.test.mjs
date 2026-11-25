// Spec 023 FR-1, FR-3, FR-4 doctor findings through
// src/brain_train/review/doctor.mjs (part of task T007).
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { collectReviewDoctorFindings } from "../src/brain_train/review/doctor.mjs"

const config = (agents) => ({ agents })

describe("collectReviewDoctorFindings", () => {
  it("lists every agent's lab and where it came from, with no warning when each owner has an other-lab reviewer", () => {
    const findings = collectReviewDoctorFindings(config({
      active: ["claude", "codex", "cursor"],
      runners: { claude: "claude -p", codex: "codex exec", cursor: "agent -p" },
      labs: { cursor: "google" },
    }))
    assert.deepEqual(findings.labs, [
      "claude: anthropic (from the claude runner)",
      "codex: openai (from the codex runner)",
      "cursor: google (from [agents.labs])",
    ])
    assert.deepEqual(findings.errors, [])
    // agent has no fresh-session entry, so it is never a same-lab reviewer.
    assert.deepEqual(findings.warnings, [
      'Agent "cursor" runs "agent", which has no fresh-session entry in the runner table, so it is never dispatched as a same-lab reviewer.',
    ])
  })

  it("warns for an agent with no lab, and names the no-other-lab owner", () => {
    const { labs, warnings } = collectReviewDoctorFindings(config({
      active: ["claude", "claude-reviewer", "cursor", "human"],
      runners: { claude: "claude -p", "claude-reviewer": "claude -p", cursor: "agent -p", human: "notify" },
    }))
    assert.ok(labs.includes("cursor: no lab"))
    assert.ok(labs.includes("human: no lab"))
    assert.ok(warnings.some((line) => line.startsWith('Agent "cursor" has no lab')))
    assert.ok(warnings.some((line) => line.startsWith('Agent "human" has no lab')))
    assert.ok(warnings.some((line) => line.includes('review "claude"\'s lanes')))
    assert.ok(warnings.some((line) => line.includes('review "claude-reviewer"\'s lanes')))
    assert.ok(!warnings.some((line) => line.includes('review "human"\'s lanes')), "a notify agent is not an owner that dispatches")
  })

  it("warns about an invalid [agents.labs] value and an unknown reviewer_order name", () => {
    const { warnings } = collectReviewDoctorFindings({
      agents: { active: ["claude", "codex"], runners: { claude: "claude -p", codex: "codex exec" }, labs: { codex: "Open AI" } },
      review: { reviewer_order: ["codex", "nobody"] },
    })
    assert.ok(warnings.some((line) => line.includes('[agents.labs] "codex" = "Open AI" is not a lowercase lab name')))
    assert.ok(warnings.some((line) => line.includes('reviewer_order names "nobody"')))
  })

  it("reports a review setting that does not parse as an error", () => {
    const { errors } = collectReviewDoctorFindings({
      agents: { active: ["claude"], runners: { claude: "claude -p" } },
      review: { silence_limit: "soon" },
    })
    assert.equal(errors.length, 1)
    assert.match(errors[0], /silence_limit = "soon" is not a duration/)
  })

  it("never turns a missing lab into an error", () => {
    const { errors } = collectReviewDoctorFindings(config({ active: ["a", "b"], runners: { a: "agent -p", b: "./review.sh" } }))
    assert.deepEqual(errors, [])
  })
})

// Spec 023 FR-1, FR-2, FR-3 through src/brain_train/review/labs.mjs (plan WS1).
// The `btrain doctor` half of WS1 (T007) edits core.mjs and lands later.
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  authorLabs,
  explainAgentLab,
  listConfiguredAgents,
  orderCandidates,
  resolveAgentLab,
  runnerKindOf,
  tierOf,
} from "../src/brain_train/review/labs.mjs"

function config({ active = [], runners = {}, labs, review, reviewerDefault } = {}) {
  return {
    agents: {
      active,
      ...(reviewerDefault ? { reviewer_default: reviewerDefault } : {}),
      runners,
      ...(labs ? { labs } : {}),
    },
    ...(review ? { review } : {}),
  }
}

describe("resolveAgentLab: the FR-1 sources of a lab", () => {
  it("takes an [agents.labs] entry first, over the runner's lab", () => {
    const cfg = config({ runners: { reviewer: "codex exec" }, labs: { reviewer: "google" } })
    assert.deepEqual(explainAgentLab(cfg, "reviewer"), { lab: "google", source: "agents.labs", executable: "codex" })
  })

  it("matches an [agents.labs] key without regard to case, and lowercases the lab", () => {
    const cfg = config({ runners: { Cursor: "agent -p" }, labs: { cursor: " Google " } })
    assert.equal(resolveAgentLab(cfg, "Cursor"), "google")
  })

  for (const [runner, lab] of [
    ["claude -p", "anthropic"],
    ["/usr/local/bin/claude -p --model opus", "anthropic"],
    ["codex exec -m gpt-6.1-sol", "openai"],
    ["\"/opt/my tools/codex\" exec", "openai"],
    ["gemini -p", "google"],
  ]) {
    it(`takes the lab of the executable basename for ${JSON.stringify(runner)}`, () => {
      const cfg = config({ runners: { someone: runner } })
      assert.deepEqual(explainAgentLab(cfg, "someone"), { lab, source: "runner", executable: runner.includes("codex") ? "codex" : runner.includes("gemini") ? "gemini" : "claude" })
    })
  }

  for (const runner of [
    "agent -p",
    "cursor-agent -p",
    "npx @openai/codex exec",
    "env FOO=1 claude -p",
    "./scripts/review.sh",
    "bash -c 'claude -p'",
    "notify",
    "NOTIFY",
    "",
  ]) {
    it(`yields no lab for the runner ${JSON.stringify(runner)}`, () => {
      const cfg = config({ runners: runner ? { someone: runner } : {} })
      assert.equal(resolveAgentLab(cfg, "someone"), "")
      assert.equal(explainAgentLab(cfg, "someone").source, "")
    })
  }

  it("never reads the agent name: claude-gpt with a codex runner is openai", () => {
    const cfg = config({ runners: { "claude-gpt": "codex exec" } })
    assert.equal(resolveAgentLab(cfg, "claude-gpt"), "openai")
  })

  it("never reads the agent name: an agent called claude with no runner has no lab", () => {
    assert.equal(resolveAgentLab(config({ active: ["claude"] }), "claude"), "")
  })

  it("gives a notify runner no lab even when the name looks like a lab's CLI", () => {
    assert.equal(resolveAgentLab(config({ runners: { codex: "notify" } }), "codex"), "")
  })

  it("reads an [agents.labs] value that ends in an inline comment", () => {
    const cfg = config({ runners: { someone: "agent -p" }, labs: { someone: '"google"  # pinned model' } })
    assert.equal(resolveAgentLab(cfg, "someone"), "google")
  })

  it("gives no lab, never a wrong one, for an [agents.labs] value that is not a label", () => {
    for (const value of ['"anthropic"  x', "open ai", "OpenAI!", "-x"]) {
      const cfg = config({ runners: { someone: "claude -p" }, labs: { someone: value } })
      const result = explainAgentLab(cfg, "someone")
      assert.equal(result.lab, "", value)
      assert.equal(result.invalid, value)
    }
    // A same-lab reviewer with a garbled lab stays same-lab: no lab is same-lab.
    const cfg = config({ active: ["claude", "claude-reviewer"], runners: { claude: "claude -p", "claude-reviewer": "claude -p" }, labs: { "claude-reviewer": "anthropic x" } })
    assert.deepEqual(orderCandidates(cfg, { owner: "claude" }).otherLab, [])
  })

  it("ignores an empty [agents.labs] entry and falls back to the runner", () => {
    const cfg = config({ runners: { someone: "claude -p" }, labs: { someone: "  " } })
    assert.equal(resolveAgentLab(cfg, "someone"), "anthropic")
  })
})

describe("runnerKindOf", () => {
  it("is cli for a command and notify for notify or a missing runner", () => {
    const cfg = config({ runners: { a: "claude -p", b: "notify" } })
    assert.equal(runnerKindOf(cfg, "a"), "cli")
    assert.equal(runnerKindOf(cfg, "b"), "notify")
    assert.equal(runnerKindOf(cfg, "c"), "notify")
  })
})

describe("listConfiguredAgents", () => {
  it("lists [agents].active, then the defaults, without duplicates or any-other", () => {
    const cfg = {
      agents: { active: ["claude", "codex"], writer_default: "Claude", reviewer_default: "any-other", runners: { extra: "claude -p" } },
    }
    assert.deepEqual(listConfiguredAgents(cfg), ["claude", "codex"])
  })

  it("falls back to the runner keys when nothing else names an agent", () => {
    assert.deepEqual(listConfiguredAgents({ agents: { runners: { x: "claude -p", y: "codex" } } }), ["x", "y"])
  })
})

describe("authorLabs and tierOf", () => {
  const cfg = config({
    runners: { claude: "claude -p", codex: "codex exec", cursor: "agent -p", gem: "gemini" },
  })

  it("collects the labs of the authors and lists the unlabeled ones", () => {
    assert.deepEqual(authorLabs(["claude", "codex", "cursor", "Claude"], cfg), { labs: ["anthropic", "openai"], unlabeled: ["cursor"] })
    assert.deepEqual(authorLabs(new Set(["gem"]), cfg), { labs: ["google"], unlabeled: [] })
  })

  it("is other-lab for a known lab outside the author labs and same-lab inside them", () => {
    assert.equal(tierOf("codex", { config: cfg, authorLabs: ["anthropic"] }), "other-lab")
    assert.equal(tierOf("claude", { config: cfg, authorLabs: ["anthropic"] }), "same-lab")
    assert.equal(tierOf("claude", { config: cfg, authorLabs: authorLabs(["claude"], cfg) }), "same-lab")
  })

  it("counts an agent with no lab as same-lab (FR-3)", () => {
    assert.equal(tierOf("cursor", { config: cfg, authorLabs: ["anthropic"] }), "same-lab")
  })
})

describe("orderCandidates: the FR-2 order", () => {
  it("puts other-lab agents first and keeps authors out of both lists", () => {
    const cfg = config({
      active: ["claude", "codex", "claude-reviewer", "codex-reviewer"],
      runners: { claude: "claude -p", codex: "codex exec", "claude-reviewer": "claude -p", "codex-reviewer": "codex exec" },
    })
    const result = orderCandidates(cfg, { owner: "claude", authorHistory: ["claude"] })
    assert.deepEqual(result.otherLab, ["codex", "codex-reviewer"])
    assert.deepEqual(result.sameLab, ["claude-reviewer"])
    assert.deepEqual(result.authorLabs, ["anthropic"])
  })

  it("keeps an agent without a cli runner out of both lists", () => {
    const cfg = config({ active: ["claude", "codex", "human"], runners: { claude: "claude -p", codex: "notify", human: "notify" } })
    const result = orderCandidates(cfg, { owner: "claude" })
    assert.deepEqual(result.otherLab, [])
    assert.deepEqual(result.sameLab, [])
  })

  it("never lists `agent -p` with no [agents.labs] entry as other-lab", () => {
    const cfg = config({ active: ["claude", "cursor"], runners: { claude: "claude -p", cursor: "agent -p" } })
    const result = orderCandidates(cfg, { owner: "claude" })
    assert.deepEqual(result.otherLab, [])
    assert.deepEqual(result.sameLab, ["cursor"])
  })

  it("lists `agent -p` as other-lab once [agents.labs] names its lab", () => {
    const cfg = config({ active: ["claude", "cursor"], runners: { claude: "claude -p", cursor: "agent -p" }, labs: { cursor: "google" } })
    assert.deepEqual(orderCandidates(cfg, { owner: "claude" }).otherLab, ["cursor"])
  })

  it("honors [review].reviewer_order and reports the names it does not know", () => {
    const cfg = config({
      active: ["claude", "codex-a", "codex-b", "gem"],
      runners: { claude: "claude -p", "codex-a": "codex exec", "codex-b": "codex exec", gem: "gemini" },
      review: { reviewer_order: ["gem", "nobody", "codex-b"] },
    })
    const result = orderCandidates(cfg, { owner: "claude" })
    assert.deepEqual(result.otherLab, ["gem", "codex-b", "codex-a"])
    assert.deepEqual(result.unknownReviewerOrder, ["nobody"])
  })

  it("puts reviewer_default first only when it is other-lab for the owner", () => {
    const runners = { claude: "claude -p", "claude-reviewer": "claude -p", "codex-a": "codex exec", "codex-b": "codex exec" }
    const active = ["claude", "claude-reviewer", "codex-a", "codex-b"]
    const otherLabDefault = orderCandidates(config({ active, runners, reviewerDefault: "codex-b" }), { owner: "claude" })
    assert.deepEqual(otherLabDefault.otherLab, ["codex-b", "codex-a"])

    const sameLabDefault = orderCandidates(config({ active, runners, reviewerDefault: "claude-reviewer" }), { owner: "claude" })
    assert.deepEqual(sameLabDefault.otherLab, ["codex-a", "codex-b"])
    assert.deepEqual(sameLabDefault.sameLab, ["claude-reviewer"])
  })

  it("treats every lab in a two-lab author history as same-lab", () => {
    const cfg = config({
      active: ["claude", "codex", "codex-reviewer", "gem"],
      runners: { claude: "claude -p", codex: "codex exec", "codex-reviewer": "codex exec", gem: "gemini" },
    })
    const result = orderCandidates(cfg, { owner: "claude", authorHistory: new Set(["claude", "codex"]) })
    assert.deepEqual(result.otherLab, ["gem"])
    assert.deepEqual(result.sameLab, ["codex-reviewer"])
  })

  it("uses the configured agents it is given in place of the config's", () => {
    const cfg = config({ active: ["claude"], runners: { claude: "claude -p", codex: "codex exec" } })
    assert.deepEqual(orderCandidates(cfg, { owner: "claude", configuredAgents: ["claude", "codex"] }).otherLab, ["codex"])
  })
})

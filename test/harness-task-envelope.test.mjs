import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  TASK_ARTIFACT_ENVELOPE_VERSION,
  buildTaskArtifactEnvelope,
  createEmptyTaskArtifactEnvelope,
  normalizeTaskArtifactEnvelope,
} from "../src/brain_train/core.mjs"

describe("task/artifact envelopes", () => {
  it("creates a stable empty envelope shape", () => {
    assert.deepEqual(createEmptyTaskArtifactEnvelope(), {
      version: TASK_ARTIFACT_ENVELOPE_VERSION,
      kind: "lane-work",
      laneId: "",
      task: "",
      status: "",
      actor: "",
      owner: "",
      reviewer: "",
      summary: "",
      artifactRefs: [],
    })
  })

  it("builds an envelope from lane state and artifact refs", () => {
    const envelope = buildTaskArtifactEnvelope(
      {
        _laneId: "a",
        task: "Research handoff gaps",
        status: "in-progress",
        owner: "codex",
        reviewer: "claude",
      },
      {
        summary: "Investigated diffless evidence handling.",
        artifactRefs: [
          { kind: "summary", label: "research note", path: "research/handoff.md" },
          { kind: "command-output", label: "doctor", path: ".btrain/logs/doctor.txt", note: "clean" },
        ],
      },
    )

    assert.deepEqual(envelope, {
      version: TASK_ARTIFACT_ENVELOPE_VERSION,
      kind: "lane-work",
      laneId: "a",
      task: "Research handoff gaps",
      status: "in-progress",
      actor: "codex",
      owner: "codex",
      reviewer: "claude",
      summary: "Investigated diffless evidence handling.",
      artifactRefs: [
        { kind: "summary", label: "research note", path: "research/handoff.md", note: "" },
        { kind: "command-output", label: "doctor", path: ".btrain/logs/doctor.txt", note: "clean" },
      ],
    })
  })

  it("normalizes and deduplicates artifact refs while preserving useful diffless metadata", () => {
    const envelope = normalizeTaskArtifactEnvelope(
      {
        kind: "diffless-output",
        laneId: "b",
        task: "Write investigation note",
        status: "needs-review",
        actor: "claude",
        owner: "claude",
        reviewer: "codex",
        summary: "  Captured   evidence without a source diff. ",
        artifactRefs: [
          { kind: "summary", label: "investigation", path: "research/out.md", note: "  ready  " },
          { kind: "summary", label: "investigation", path: "research/out.md", note: "ready" },
          { kind: "log", path: "logs/run.txt" },
          { kind: "ignored" },
        ],
      },
      createEmptyTaskArtifactEnvelope(),
    )

    assert.deepEqual(envelope, {
      version: TASK_ARTIFACT_ENVELOPE_VERSION,
      kind: "diffless-output",
      laneId: "b",
      task: "Write investigation note",
      status: "needs-review",
      actor: "claude",
      owner: "claude",
      reviewer: "codex",
      summary: "Captured evidence without a source diff.",
      artifactRefs: [
        { kind: "summary", label: "investigation", path: "research/out.md", note: "ready" },
        { kind: "log", label: "", path: "logs/run.txt", note: "" },
      ],
    })
  })

  it("falls back to lane-work when the kind is unsupported", () => {
    const envelope = normalizeTaskArtifactEnvelope({
      kind: "unknown-kind",
      task: "Keep shape stable",
    })

    assert.equal(envelope.kind, "lane-work")
    assert.equal(envelope.task, "Keep shape stable")
  })

  it("accepts artifacts as an alias for artifactRefs", () => {
    const envelope = buildTaskArtifactEnvelope(
      {
        lane: "c",
        task: "Capture repair evidence",
        status: "repair-needed",
        owner: "codex",
        reviewer: "claude",
      },
      {
        kind: "repair",
        artifacts: [{ kind: "report", label: "repair note", path: "artifacts/repair.md" }],
      },
    )

    assert.deepEqual(envelope.artifactRefs, [
      { kind: "report", label: "repair note", path: "artifacts/repair.md", note: "" },
    ])
    assert.equal(envelope.kind, "repair")
    assert.equal(envelope.laneId, "c")
  })
})

const TASK_ARTIFACT_ENVELOPE_VERSION = 1
const TASK_ARTIFACT_KINDS = new Set([
  "lane-work",
  "review",
  "repair",
  "delegated-wakeup",
  "diffless-output",
])

function normalizeText(value, fallbackValue = "") {
  if (Array.isArray(value)) {
    const lines = value
      .flatMap((item) => String(item).split("\n"))
      .map((line) => line.trim())
      .filter(Boolean)
    return lines.length > 0 ? lines.join(" ") : fallbackValue
  }

  if (value === undefined || value === null) {
    return fallbackValue
  }

  const normalized = String(value)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ")

  return normalized || fallbackValue
}

function normalizeTaskArtifactKind(value, fallbackValue = "lane-work") {
  const normalized = typeof value === "string" ? value.trim() : ""
  if (TASK_ARTIFACT_KINDS.has(normalized)) {
    return normalized
  }
  return TASK_ARTIFACT_KINDS.has(fallbackValue) ? fallbackValue : "lane-work"
}

function createEmptyTaskArtifactEnvelope() {
  return {
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
  }
}

function normalizeArtifactReference(reference = {}) {
  if (!reference || typeof reference !== "object") {
    return null
  }

  const kind = normalizeText(reference.kind, "artifact").replace(/\s+/g, " ").trim() || "artifact"
  const label = normalizeText(reference.label, "").replace(/\s+/g, " ").trim()
  const artifactPath = normalizeText(reference.path, "").replace(/\s+/g, " ").trim()
  const note = normalizeText(reference.note, "").replace(/\s+/g, " ").trim()

  if (!label && !artifactPath && !note) {
    return null
  }

  return {
    kind,
    label,
    path: artifactPath,
    note,
  }
}

function normalizeArtifactReferences(references = []) {
  if (!Array.isArray(references)) {
    return []
  }

  const normalized = []
  const seen = new Set()

  for (const reference of references) {
    const artifactRef = normalizeArtifactReference(reference)
    if (!artifactRef) {
      continue
    }

    const dedupeKey = [
      artifactRef.kind,
      artifactRef.label,
      artifactRef.path,
      artifactRef.note,
    ].join("\u0000")

    if (seen.has(dedupeKey)) {
      continue
    }

    seen.add(dedupeKey)
    normalized.push(artifactRef)
  }

  return normalized
}

function normalizeTaskArtifactEnvelope(envelope = {}, defaults = createEmptyTaskArtifactEnvelope()) {
  const fallback = {
    ...createEmptyTaskArtifactEnvelope(),
    ...defaults,
  }

  return {
    version: TASK_ARTIFACT_ENVELOPE_VERSION,
    kind: normalizeTaskArtifactKind(envelope.kind, fallback.kind),
    laneId: normalizeText(envelope.laneId, fallback.laneId).replace(/\s+/g, " ").trim(),
    task: normalizeText(envelope.task, fallback.task).replace(/\s+/g, " ").trim(),
    status: normalizeText(envelope.status, fallback.status).replace(/\s+/g, " ").trim(),
    actor: normalizeText(envelope.actor, fallback.actor).replace(/\s+/g, " ").trim(),
    owner: normalizeText(envelope.owner, fallback.owner).replace(/\s+/g, " ").trim(),
    reviewer: normalizeText(envelope.reviewer, fallback.reviewer).replace(/\s+/g, " ").trim(),
    summary: normalizeText(envelope.summary, fallback.summary).replace(/\s+/g, " ").trim(),
    artifactRefs: normalizeArtifactReferences(
      envelope.artifactRefs !== undefined
        ? envelope.artifactRefs
        : envelope.artifacts !== undefined
          ? envelope.artifacts
          : fallback.artifactRefs,
    ),
  }
}

function buildTaskArtifactEnvelope(current = {}, options = {}) {
  const fallback = {
    kind: options.kind || "lane-work",
    laneId: current._laneId || current.lane || "",
    task: current.task || "",
    status: current.status || "",
    actor: options.actor || current.actor || current.owner || current["active agent"] || "",
    owner: current.owner || current["active agent"] || "",
    reviewer: current.reviewer || current["peer reviewer"] || "",
    summary: options.summary || "",
    artifactRefs: options.artifactRefs || options.artifacts || [],
  }

  return normalizeTaskArtifactEnvelope(
    {
      ...current,
      ...options,
    },
    fallback,
  )
}

export {
  TASK_ARTIFACT_ENVELOPE_VERSION,
  buildTaskArtifactEnvelope,
  createEmptyTaskArtifactEnvelope,
  normalizeTaskArtifactEnvelope,
}

const kinds = new Set(["dispatch", "transcript"])

function median(values) {
  const ordered = [...values].sort((a, b) => a - b)
  const center = Math.floor(ordered.length / 2)
  return ordered.length % 2 ? ordered[center] : (ordered[center - 1] + ordered[center]) / 2
}

// Paired accounting only. G7 needs a frozen, independently collected real benchmark.
export function evaluateContextPairs(kind, pairs) {
  if (!kinds.has(kind) || !Array.isArray(pairs) || !pairs.length) throw new Error("A nonempty dispatch or transcript pair set is required")
  const ids = new Set()
  for (const pair of pairs) {
    if (pair.kind !== kind || typeof pair.id !== "string" || !pair.id || ids.has(pair.id)
      || !Number.isSafeInteger(pair.baselineTokens) || pair.baselineTokens <= 0
      || !Number.isSafeInteger(pair.selectedTokens) || pair.selectedTokens < 0
      || typeof pair.baselineCompleted !== "boolean" || typeof pair.selectedCompleted !== "boolean"
      || !Number.isSafeInteger(pair.pinnedOmissions) || pair.pinnedOmissions < 0
      || !["real", "synthetic", "unknown"].includes(pair.origin)
      || (pair.origin === "real" && (!/^https?:\/\//.test(pair.sourceRef || "") || !/^[a-f0-9]{64}$/.test(pair.sourceSnapshotHash || "")))) {
      throw new Error("Every case needs unique, valid paired measurements from one family")
    }
    ids.add(pair.id)
  }
  const reduction = median(pairs.map(({ baselineTokens, selectedTokens }) => (baselineTokens - selectedTokens) / baselineTokens))
  const completionDifferencePercentagePoints = 100 * (
    pairs.filter((pair) => pair.selectedCompleted).length - pairs.filter((pair) => pair.baselineCompleted).length
  ) / pairs.length
  return {
    kind,
    cases: pairs.length,
    realCases: pairs.filter((pair) => pair.origin === "real").length,
    medianTokenReduction: reduction,
    completionDifferencePercentagePoints,
    pinnedOmissions: pairs.reduce((total, pair) => total + pair.pinnedOmissions, 0),
    gateReady: false,
    gateReason: "requires-frozen-real-benchmark",
  }
}

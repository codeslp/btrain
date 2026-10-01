// Options that btrain passes to its own handoff functions and that no caller
// may supply. patchHandoff and resolveHandoff read the spec 015 transition
// gate's classification inputs from the same options object as the CLI flags,
// and parseOptions turns any `--key value` into an option, so the CLI refuses
// these: a transition's classification comes from the btrain code path that
// reached the gate, never from the caller.
// test/cli-internal-options.test.mjs fails when an internal caller passes a
// handoff function an option that is neither a documented flag nor listed here.
export const INTERNAL_ONLY_OPTIONS = Object.freeze({
  transitionEvent:
    "is the transition label that `btrain pr poll --apply` (pr-poll) and `btrain pr create` (pr-create) pass to `handoff update`. A label from the caller would choose the row that gates the change, and system rows such as 10 (PrClear) accept any actor.",
  transitionCompatibility:
    "is set by `btrain pr create` so its own PR link takes row 7 (LinkPr) without the owner check.",
  viaPrOutcome:
    "is set by `btrain pr poll --apply` when a merged or closed PR resolves the lane through row 11 (PrTerminal), past the `--final` guard.",
  onEvent: "is the progress callback that btrain passes to the handoff functions.",
})

// parseOptions keeps `--key=value` as one key, so the name ends at `=`.
function normalizeOptionName(name) {
  return String(name).split("=")[0].toLowerCase().replace(/[-_]/g, "")
}

const INTERNAL_KEY_BY_NAME = new Map(
  Object.keys(INTERNAL_ONLY_OPTIONS).map((key) => [normalizeOptionName(key), key]),
)

// The parsed options that name an internal option, in any case and with or
// without dashes or underscores, so a future flag-name normalization cannot
// turn `--transition-event` into `transitionEvent` behind this check.
export function findInternalOnlyOptions(options = {}) {
  return Object.keys(options)
    .filter((flag) => flag !== "_")
    .map((flag) => ({ flag, key: INTERNAL_KEY_BY_NAME.get(normalizeOptionName(flag)) }))
    .filter((entry) => entry.key)
}

// BtrainError fields for the options that findInternalOnlyOptions reported.
export function internalOnlyOptionError(found) {
  const flags = found.map(({ flag }) => `\`--${flag}\``).join(", ")
  return {
    message: `${flags} ${found.length === 1 ? "is" : "are"} internal to btrain and cannot be set on the command line.`,
    reason: `btrain classifies each lane transition itself (spec 015). ${found
      .map(({ key }) => `\`${key}\` ${INTERNAL_ONLY_OPTIONS[key]}`)
      .join(" ")}`,
    fix: `Re-run without ${flags}. Apply a PR outcome with \`btrain pr poll --lane <id> --apply\`, and open and link a PR with \`btrain pr create --lane <id>\`.`,
  }
}

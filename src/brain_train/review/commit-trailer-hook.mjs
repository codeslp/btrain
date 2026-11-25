// Spec 023 FR-13 and FR-14 (part of task T037): the text of btrain's managed
// `commit-msg` hook. It appends `Btrain-Agent: <agent>` to a commit message
// when `BTRAIN_AGENT` (or `BRAIN_TRAIN_AGENT`) is set and the message has no
// such trailer, so `btrain handoff fix` can check that every commit of a fix
// range is the active reviewer's. A commit made with `git commit --no-verify`
// skips the hook and has no trailer, so that bypass is caught at
// `handoff fix`. A trailer typed by hand is accepted: this raises the bar and
// is not proof.
//
// Pure. Wiring the hook into `managedHookSpecs` (core.mjs) is the rest of
// T037 and lands with the core.mjs work.

export const COMMIT_MSG_HOOK_MARKER = "# btrain:commit-msg-hook"
export const TRAILER_KEY = "Btrain-Agent"

/**
 * The managed `commit-msg` hook. The agent name is reduced to the characters
 * an agent name uses, so a value with a line break cannot add a second
 * trailer.
 */
export function renderCommitMsgHook() {
  return [
    "#!/bin/sh",
    COMMIT_MSG_HOOK_MARKER,
    `# Appends "${TRAILER_KEY}: <agent>" naming the committing btrain agent (spec 023 FR-13).`,
    "# Installed by: btrain init --hooks",
    "# Skipped by: git commit --no-verify (handoff fix then refuses the commit)",
    "",
    'MSG_FILE="$1"',
    '[ -n "$MSG_FILE" ] && [ -f "$MSG_FILE" ] || exit 0',
    'AGENT=$(printf "%s" "${BTRAIN_AGENT:-$BRAIN_TRAIN_AGENT}" | tr -cd "A-Za-z0-9._-")',
    '[ -n "$AGENT" ] || exit 0',
    `if grep -qi "^${TRAILER_KEY}[[:space:]]*:" "$MSG_FILE"; then`,
    "  exit 0",
    "fi",
    `git interpret-trailers --in-place --trailer "${TRAILER_KEY}: $AGENT" "$MSG_FILE"`,
    "",
  ].join("\n")
}

/**
 * The agent a commit message's last `Btrain-Agent` trailer names, or "".
 * Only a trailer line counts: `Btrain-Agent:` at the start of a line.
 */
export function readTrailerAgent(message) {
  const matches = [...String(message || "").matchAll(new RegExp(`^${TRAILER_KEY}[ \\t]*:[ \\t]*([A-Za-z0-9._-]+)[ \\t]*$`, "gim"))]
  return matches.length > 0 ? matches.at(-1)[1] : ""
}

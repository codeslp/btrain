// Spec 025 FR-7, FR-16 and the plan's "The reply": what a model wrote is
// untrusted text. Split it into prose and at most one proposal, check the
// proposal, and prepare the prose with the whole text handling of spec 024
// FR-8, cut to 3,000 characters. Pure. Imports nothing from core.mjs.
//
// A proposal is rejected, and nothing is stored, when:
// - the reply holds more than one `btrain>` line (the prose is kept, with a note);
// - it fails the grammar or the verb table;
// - it names `pause`, which only the operator may type;
// - the scrub step or the URL rewrite of spec 024 FR-8 would change its
//   canonical text, so what is shown would differ from what runs;
// - its canonical text holds a code fence, which would end the code block it
//   is posted in;
// - the posted message, with its code block and approval line, would be over
//   3,999 characters.

import { findCommand, parseModelCommand } from "./grammar.mjs"
import { defangUrls, escapeSlackText, MAX_MESSAGE_CHARS, prepareAgentText, scrubSecrets } from "./text.mjs"
import { APPROVAL, VERBS } from "./verbs.mjs"

export const MAX_PROSE_CHARS = 3000

/**
 * The message a proposal is posted as: the canonical text in a code block,
 * escaped (which, inside a code block, changes nothing the operator sees), and
 * the approval line.
 */
export function renderProposalMessage(canonical, { approvalMinutes = 15, needsApproval = true } = {}) {
  const line = needsApproval
    ? `Reply \`approve\` in this thread within ${approvalMinutes} minutes to run it, or \`reject\`.`
    : "This command is on the auto list and runs now."
  return `\`\`\`\n${escapeSlackText(canonical).text}\n\`\`\`\n${line}`
}

function checkProposal(checked, { approvalMinutes }) {
  if (VERBS[checked.verb].approval === APPROVAL.TYPED_ONLY) {
    return `${checked.verb} can only be typed by the operator`
  }
  if (scrubSecrets(checked.canonical).changed) return "the proposal holds text that matches a secret pattern"
  if (defangUrls(checked.canonical).changed) return "the proposal holds a URL"
  if (checked.canonical.includes("```")) return "the proposal holds a code fence"
  const message = renderProposalMessage(checked.canonical, { approvalMinutes })
  if (Array.from(message).length > MAX_MESSAGE_CHARS) return `the proposal would not fit in one ${MAX_MESSAGE_CHARS}-character message`
  return ""
}

/**
 * Split a model's raw reply. `channel` is the channel context the grammar
 * checks against (`{ repos }`). Returns
 * `{ prose, proposal, notes }`: `prose` is ready to post (possibly empty);
 * `proposal` is `{ verb, repo, values, canonical }` or null; `notes` are short
 * fixed reasons a proposal part was dropped, safe to post.
 */
export function splitModelReply(raw, { channel = {}, approvalMinutes = 15 } = {}) {
  const text = typeof raw === "string" ? raw : ""
  const lines = text.split("\n")
  const notes = []
  let proposal = null
  let proseLines = lines

  const found = findCommand(text)
  if (found.many) {
    // Every command line and its fields are dropped from the prose.
    const kept = []
    let inBlock = false
    for (const line of lines) {
      if (line.trimStart().startsWith("btrain>")) {
        inBlock = true
        continue
      }
      if (inBlock && line.trim() !== "") continue
      inBlock = false
      kept.push(line)
    }
    proseLines = kept
    notes.push("The reply held more than one btrain> command, so none was proposed.")
  } else if (found.found) {
    proseLines = [...lines.slice(0, found.start), ...lines.slice(found.end)]
    const checked = parseModelCommand(text, channel)
    if (!checked.ok) {
      notes.push(`The proposed command was not valid: ${checked.reason}.`)
    } else {
      const reason = checkProposal(checked, { approvalMinutes })
      if (reason) {
        notes.push(`The proposed command was not posted: ${reason}.`)
      } else {
        proposal = { verb: checked.verb, repo: checked.repo, values: checked.values, canonical: checked.canonical }
      }
    }
  }

  const prose = prepareAgentText(proseLines.join("\n").trim(), { maxChars: MAX_PROSE_CHARS })
  // A note is fixed text with one grammar reason in it; it goes through the
  // same handling, so a reason that quotes model text stays inert.
  return { prose, proposal, notes: notes.map((note) => prepareAgentText(note, { maxChars: 500, singleLine: true })) }
}

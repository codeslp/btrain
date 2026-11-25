// Spec 025 FR-5, FR-6, FR-13 and the plan's "Which messages are heard": the
// rule that decides whether one Slack message is heard, and as what. Pure.
// Imports nothing from core.mjs.
//
// Rules, in order, for one message from a read call:
//
//   `user` is not the operator, or `app_id` or `bot_id` is present  -> ignored
//   a `subtype` other than `thread_broadcast`                       -> ignored
//   from history, `thread_ts` present and not its own `ts`           -> ignored (a reply shown in the channel)
//   from history, top level, the text has a command                  -> command
//   from history, top level, the text mentions the bot               -> conversation
//   from history, anything else                                       -> ignored
//   from replies of an open thread, the parent message                -> ignored (skipped by its ts)
//   from replies, the whole text is `approve` or `reject`             -> approval
//   from replies, the text has a command                              -> command
//   from replies, anything else                                       -> turn (the next turn of the conversation)
//
// The rule reads only `type`, `subtype`, `ts`, `thread_ts`, `user`, `app_id`,
// `bot_id`, and `text`. It does not require `client_msg_id` (plan, "Slack
// contract").

import { decodeSlackText, hasCommand } from "./grammar.mjs"

export const HEARD = Object.freeze({
  IGNORED: "ignored",
  COMMAND: "command",
  CONVERSATION: "conversation",
  APPROVAL: "approval",
  TURN: "turn",
})

export const SOURCES = Object.freeze({ HISTORY: "history", REPLIES: "replies" })

function present(value) {
  return value !== undefined && value !== null && value !== ""
}

function mentionsBot(text, botUserId) {
  if (!botUserId) return false
  const escaped = String(botUserId).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(`<@${escaped}(?:\\|[^>]*)?>`).test(String(text ?? ""))
}

/**
 * Classify one message. `context` is `{ operator, botUserId, source, parentTs }`:
 * `source` is `history` or `replies`, and `parentTs` is the thread's own `ts`
 * when the message came from `conversations.replies`.
 *
 * Returns `{ heard, reason, approval?, authors }`. `authors` holds only the
 * author fields (`user`, `app_id`, `bot_id`, `subtype`), for the one local log
 * line an ignored message gets; no message text is ever returned.
 */
export function classifyInbound(message, { operator, botUserId, source = SOURCES.HISTORY, parentTs = "" } = {}) {
  const item = message && typeof message === "object" ? message : {}
  const authors = { user: item.user ?? null, app_id: item.app_id ?? null, bot_id: item.bot_id ?? null, subtype: item.subtype ?? null }
  const ignored = (reason) => ({ heard: HEARD.IGNORED, reason, authors })

  if (!operator) return ignored("no operator is configured")
  if (item.user !== operator) return ignored("not the operator")
  if (present(item.app_id) || present(item.bot_id)) return ignored("posted by an app or a bot")
  if (present(item.type) && item.type !== "message") return ignored(`not a message (${item.type})`)
  if (present(item.subtype) && item.subtype !== "thread_broadcast") return ignored(`subtype ${item.subtype}`)
  if (!present(item.ts)) return ignored("no ts")

  const text = typeof item.text === "string" ? item.text : ""
  if (source === SOURCES.HISTORY) {
    if (present(item.thread_ts) && item.thread_ts !== item.ts) return ignored("a thread reply shown in the channel")
    if (hasCommand(decodeSlackText(text))) return { heard: HEARD.COMMAND, reason: "", authors }
    if (mentionsBot(text, botUserId)) return { heard: HEARD.CONVERSATION, reason: "", authors }
    return ignored("a top-level message with no command and no mention")
  }
  if (source === SOURCES.REPLIES) {
    if (present(parentTs) && item.ts === parentTs) return ignored("the thread's parent message")
    const whole = text.trim()
    if (whole === "approve" || whole === "reject") return { heard: HEARD.APPROVAL, reason: "", approval: whole, authors }
    if (hasCommand(decodeSlackText(text))) return { heard: HEARD.COMMAND, reason: "", authors }
    return { heard: HEARD.TURN, reason: "", authors }
  }
  return ignored(`unknown source ${source}`)
}

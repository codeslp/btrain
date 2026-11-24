// Spec 024 FR-8 through src/brain_train/slack/text.mjs (plan WS1, T003).
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  capMessage,
  cutText,
  defangUrls,
  escapeSlackText,
  MAX_MESSAGE_CHARS,
  prepareAgentText,
  scrubSecrets,
} from "../src/brain_train/slack/text.mjs"

// Fake values, built at runtime so the source holds no string that matches a
// secret pattern (`btrain review code` reports those as hardcoded secrets).
const GITHUB_PAT = ["github", "pat", "1".repeat(22), "2".repeat(59)].join("_")
const GITHUB_CLASSIC = ["ghp", "3".repeat(36)].join("_")
const WEBHOOK_PATH = ["hooks.slack.com", "services", "T0000FAKE", "B0000FAKE", "4".repeat(24)].join("/")
const WEBHOOK = `https://${WEBHOOK_PATH}`
const SLACK_TOKEN = ["xoxb", "0000", "fake", "token"].join("-")

function assertInert(text) {
  assert.doesNotMatch(text, /[<>]/, "no raw angle bracket, so no mention or link markup")
  assert.doesNotMatch(text, /:\/\//, "no scheme separator, so Slack makes no link")
}

describe("the four steps, each on its own", () => {
  it("scrubSecrets replaces every secret match and says so", () => {
    const input = `a ${GITHUB_PAT} b ${GITHUB_CLASSIC} c ${WEBHOOK} d ${SLACK_TOKEN} e ${GITHUB_CLASSIC}`
    const { text, changed } = scrubSecrets(input)
    assert.equal(changed, true)
    assert.equal(text, "a [redacted] b [redacted] c [redacted] d [redacted] e [redacted]")
    assert.deepEqual(scrubSecrets("plain text"), { text: "plain text", changed: false })
  })

  it("scrubSecrets catches a webhook URL written without its scheme", () => {
    assert.equal(scrubSecrets(`see ${WEBHOOK_PATH} now`).text, "see [redacted] now")
  })

  it("cutText cuts on a character boundary and counts the ellipsis", () => {
    assert.deepEqual(cutText("abcdef", 4), { text: "abc…", changed: true })
    assert.deepEqual(cutText("abc", 4), { text: "abc", changed: false })
    assert.deepEqual(cutText("abc", undefined), { text: "abc", changed: false })
    // An emoji is two UTF-16 units; the cut never splits it.
    const { text } = cutText("😀😀😀😀", 3)
    assert.equal(text, "😀😀…")
    assert.equal(Array.from(text).length, 3)
  })

  it("escapeSlackText escapes &, <, and >", () => {
    assert.deepEqual(escapeSlackText("a & <b> c"), { text: "a &amp; &lt;b&gt; c", changed: true })
    assert.deepEqual(escapeSlackText("plain"), { text: "plain", changed: false })
  })

  it("defangUrls rewrites every scheme separator", () => {
    assert.deepEqual(defangUrls("https://a.example and ftp://b"), { text: "https[:]//a.example and ftp[:]//b", changed: true })
    assert.deepEqual(defangUrls("no link"), { text: "no link", changed: false })
  })
})

describe("prepareAgentText", () => {
  it("leaves no mention, channel-wide notification, or link from agent text", () => {
    const hostile = "<!channel> <!here> <@U123> <#C123> <!subteam^S123> & <https://evil.invalid|click> https://evil.invalid/x"
    const text = prepareAgentText(hostile)
    assertInert(text)
    assert.equal(
      text,
      "&lt;!channel&gt; &lt;!here&gt; &lt;@U123&gt; &lt;#C123&gt; &lt;!subteam^S123&gt; &amp; &lt;https[:]//evil.invalid|click&gt; https[:]//evil.invalid/x",
    )
  })

  it("redacts a webhook URL and a github_pat_ token, and links neither", () => {
    const text = prepareAgentText(`hook ${WEBHOOK} token ${GITHUB_PAT} url https://example.invalid`)
    assertInert(text)
    assert.equal(text, "hook [redacted] token [redacted] url https[:]//example.invalid")
    assert.ok(!text.includes(WEBHOOK_PATH))
    assert.ok(!text.includes("1".repeat(22)))
  })

  it("fully redacts a secret that crosses the cut point", () => {
    const prefix = "x".repeat(20)
    const text = prepareAgentText(`${prefix}${GITHUB_PAT} and more`, { maxChars: 31 })
    assert.ok(!text.includes("github_pat"), text)
    assert.ok(!/1{5}/.test(text), `no fragment of the token survives: ${text}`)
    assert.equal(text, `${prefix}[redacted]…`)
  })

  it("cuts to the field's length before escaping", () => {
    assert.equal(prepareAgentText("a&b&c&d", { maxChars: 4 }), "a&amp;b…")
  })

  it("turns null and numbers into text", () => {
    assert.equal(prepareAgentText(null), "")
    assert.equal(prepareAgentText(42), "42")
  })
})

describe("capMessage", () => {
  it("caps a message at 3,999 characters", () => {
    assert.equal(MAX_MESSAGE_CHARS, 3999)
    const capped = capMessage("y".repeat(10_000))
    assert.equal(Array.from(capped).length, 3999)
    assert.ok(capped.endsWith("…"))
    assert.equal(capMessage("short"), "short")
  })

  it("does not leave a broken escape at the cut", () => {
    const message = `${"z".repeat(3997)}&amp;tail`
    const capped = capMessage(message)
    assert.ok(Array.from(capped).length <= 3999)
    assert.doesNotMatch(capped, /&[a-z]{0,3}…$/)
  })

  it("keeps a message built from maximum-length escaped fields under the limit and inert", () => {
    const field = prepareAgentText("<&>".repeat(2000), { maxChars: 2000 })
    const message = capMessage(`task: ${field}\nsummary: ${field}`)
    assert.ok(Array.from(message).length <= 3999)
    assertInert(message)
  })
})

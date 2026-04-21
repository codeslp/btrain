import { describe, it } from "node:test"
import assert from "node:assert/strict"

import {
  createClaudeStreamObserver,
} from "../../src/brain_train/runners/stream-observers.mjs"

// PIN: these fixtures freeze the Claude stream-json contract as btrain
// understands it. If Claude Code changes its stream shape, these tests
// will fail first — forcing an explicit parser update before drift
// propagates to production loop runs. See spec 013 "Runtime adapter pins".

function captureEvents() {
  const events = []
  return {
    events,
    onEvent: (line) => events.push(line),
  }
}

function feed(observer, ...chunks) {
  for (const chunk of chunks) {
    observer.consumeStdoutChunk(chunk)
  }
  observer.flush()
}

describe("claude-stream-observer PIN: assistant text", () => {
  it("emits agent progress for a simple text message", () => {
    const { events, onEvent } = captureEvents()
    const obs = createClaudeStreamObserver(onEvent)
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "text", text: "Reading the spec now." }],
      },
    })
    feed(obs, `${line}\n`)
    assert.deepEqual(events, ["agent progress:", "  Reading the spec now."])
    assert.equal(obs.streamedStdout, true)
  })

  it("collapses whitespace and truncates very long text", () => {
    const { events, onEvent } = captureEvents()
    const obs = createClaudeStreamObserver(onEvent)
    const text = "a".repeat(300)
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: `  hello\n\n  ${text}  ` }] },
    })
    feed(obs, `${line}\n`)
    // body is one "agent progress:" label followed by one indented content line
    assert.equal(events[0], "agent progress:")
    assert.ok(events[1].startsWith("  hello"))
    assert.ok(events[1].endsWith("..."), `expected truncation, got: ${events[1]}`)
  })
})

describe("claude-stream-observer PIN: tool use + tool result", () => {
  it("emits tool use with summarized input", () => {
    const { events, onEvent } = captureEvents()
    const obs = createClaudeStreamObserver(onEvent)
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            name: "Bash",
            input: { command: "git status" },
          },
        ],
      },
    })
    feed(obs, `${line}\n`)
    assert.deepEqual(events, ["agent progress:", "  tool Bash: git status"])
  })

  it("emits tool use with JSON input when no command field", () => {
    const { events, onEvent } = captureEvents()
    const obs = createClaudeStreamObserver(onEvent)
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", name: "Read", input: { file_path: "/a.md" } },
        ],
      },
    })
    feed(obs, `${line}\n`)
    assert.equal(events[0], "agent progress:")
    assert.ok(events[1].includes("tool Read:"))
    assert.ok(events[1].includes("file_path"))
  })

  it("emits tool result from stdout, stderr, or status fallbacks", () => {
    const cases = [
      [{ stdout: "all good" }, "  tool result: all good"],
      [{ stderr: "warning: x", stdout: "" }, "  tool result: warning: x"],
      [{ interrupted: true }, "  tool result: interrupted"],
      [{}, "  tool result: completed"],
    ]
    for (const [toolResult, expected] of cases) {
      const { events, onEvent } = captureEvents()
      const obs = createClaudeStreamObserver(onEvent)
      const line = JSON.stringify({ type: "user", tool_use_result: toolResult })
      feed(obs, `${line}\n`)
      assert.deepEqual(events, ["agent progress:", expected])
    }
  })
})

describe("claude-stream-observer PIN: result dispatch", () => {
  it("emits result when success summary differs from last assistant text", () => {
    const { events, onEvent } = captureEvents()
    const obs = createClaudeStreamObserver(onEvent)
    const assistantLine = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "working" }] },
    })
    const resultLine = JSON.stringify({
      type: "result",
      subtype: "success",
      result: "Shipped the spec.",
    })
    feed(obs, `${assistantLine}\n${resultLine}\n`)
    const tail = events.filter((e) => e.includes("result:"))
    assert.ok(tail.some((e) => e.includes("result: Shipped the spec.")))
  })

  it("suppresses result when identical to last assistant text", () => {
    const { events, onEvent } = captureEvents()
    const obs = createClaudeStreamObserver(onEvent)
    const msg = "Done."
    feed(
      obs,
      `${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: msg }] } })}\n`,
      `${JSON.stringify({ type: "result", subtype: "success", result: msg })}\n`,
    )
    // Only the assistant emission should appear; no duplicate result line.
    assert.ok(!events.some((e) => e.includes("result:")))
  })

  it("emits error when is_error is true", () => {
    const { events, onEvent } = captureEvents()
    const obs = createClaudeStreamObserver(onEvent)
    const line = JSON.stringify({
      type: "result",
      is_error: true,
      result: "API rate limit",
    })
    feed(obs, `${line}\n`)
    assert.deepEqual(events, ["agent progress:", "  error: API rate limit"])
  })
})

describe("claude-stream-observer PIN: streaming correctness", () => {
  it("handles lines split across chunks", () => {
    const { events, onEvent } = captureEvents()
    const obs = createClaudeStreamObserver(onEvent)
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "Chunked message." }] },
    })
    const mid = Math.floor(line.length / 2)
    feed(obs, line.slice(0, mid), line.slice(mid) + "\n")
    assert.deepEqual(events, ["agent progress:", "  Chunked message."])
  })

  it("preserves malformed JSON in bufferedStdout instead of emitting", () => {
    const { events, onEvent } = captureEvents()
    const obs = createClaudeStreamObserver(onEvent)
    feed(obs, "not-json-at-all\n")
    assert.equal(events.length, 0)
    assert.equal(obs.bufferedStdout, "not-json-at-all")
    assert.equal(obs.streamedStdout, false)
  })

  it("flush emits a trailing line without newline", () => {
    const { events, onEvent } = captureEvents()
    const obs = createClaudeStreamObserver(onEvent)
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "tail" }] },
    })
    obs.consumeStdoutChunk(line) // no trailing newline
    assert.equal(events.length, 0)
    obs.flush()
    assert.deepEqual(events, ["agent progress:", "  tail"])
  })

  it("captures stderr without emitting it", () => {
    const { events, onEvent } = captureEvents()
    const obs = createClaudeStreamObserver(onEvent)
    obs.consumeStderrChunk("some warning")
    obs.consumeStderrChunk(" and more")
    assert.equal(events.length, 0)
    assert.equal(obs.bufferedStderr, "some warning and more")
  })
})

import { describe, it } from "node:test"
import assert from "node:assert/strict"

import {
  createCodexStreamObserver,
} from "../../src/brain_train/runners/stream-observers.mjs"

// PIN: these fixtures freeze the Codex JSON stream contract as btrain
// understands it. If Codex changes its event shape, these tests fail
// first — catching drift before it reaches a live loop run. See spec
// 013 "Runtime adapter pins".

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

describe("codex-stream-observer PIN: command lifecycle", () => {
  it("emits command started with summarized command", () => {
    const { events, onEvent } = captureEvents()
    const obs = createCodexStreamObserver(onEvent)
    const line = JSON.stringify({
      type: "item.started",
      item: { type: "command_execution", command: "git status" },
    })
    feed(obs, `${line}\n`)
    assert.deepEqual(events, ["agent progress:", "  command: git status"])
  })

  it("unwraps shell wrapped commands (-lc '...')", () => {
    const { events, onEvent } = captureEvents()
    const obs = createCodexStreamObserver(onEvent)
    const line = JSON.stringify({
      type: "item.started",
      item: {
        type: "command_execution",
        command: "bash -lc 'ls -la /tmp'",
      },
    })
    feed(obs, `${line}\n`)
    assert.equal(events[0], "agent progress:")
    assert.equal(events[1], "  command: ls -la /tmp")
  })

  it("emits command finished with both command and output", () => {
    const { events, onEvent } = captureEvents()
    const obs = createCodexStreamObserver(onEvent)
    const line = JSON.stringify({
      type: "item.completed",
      item: {
        type: "command_execution",
        command: "git status",
        aggregated_output: "On branch main\nnothing to commit",
        exit_code: 0,
      },
    })
    feed(obs, `${line}\n`)
    assert.ok(events.some((e) => e === "  command finished: git status"))
    assert.ok(events.some((e) => e.startsWith("  command result:")))
  })

  it("reports non-zero exit when no output is captured", () => {
    const { events, onEvent } = captureEvents()
    const obs = createCodexStreamObserver(onEvent)
    const line = JSON.stringify({
      type: "item.completed",
      item: {
        type: "command_execution",
        command: "false",
        aggregated_output: "",
        exit_code: 1,
      },
    })
    feed(obs, `${line}\n`)
    assert.ok(events.some((e) => e.includes("command exited 1")))
  })

  it("reports completion without output when exit is zero", () => {
    const { events, onEvent } = captureEvents()
    const obs = createCodexStreamObserver(onEvent)
    const line = JSON.stringify({
      type: "item.completed",
      item: {
        type: "command_execution",
        command: "true",
        aggregated_output: "",
        exit_code: 0,
      },
    })
    feed(obs, `${line}\n`)
    assert.ok(events.some((e) => e.includes("command completed")))
  })
})

describe("codex-stream-observer PIN: agent_message + error", () => {
  it("emits agent_message text", () => {
    const { events, onEvent } = captureEvents()
    const obs = createCodexStreamObserver(onEvent)
    const line = JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: "The build passed." },
    })
    feed(obs, `${line}\n`)
    assert.deepEqual(events, ["agent progress:", "  The build passed."])
  })

  it("ignores agent_message with empty text", () => {
    const { events, onEvent } = captureEvents()
    const obs = createCodexStreamObserver(onEvent)
    const line = JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: "   " },
    })
    feed(obs, `${line}\n`)
    assert.equal(events.length, 0)
  })

  it("emits error with message", () => {
    const { events, onEvent } = captureEvents()
    const obs = createCodexStreamObserver(onEvent)
    const line = JSON.stringify({ type: "error", message: "auth expired" })
    feed(obs, `${line}\n`)
    assert.deepEqual(events, ["agent progress:", "  error: auth expired"])
  })
})

describe("codex-stream-observer PIN: streaming correctness", () => {
  it("handles multiple events in one chunk", () => {
    const { events, onEvent } = captureEvents()
    const obs = createCodexStreamObserver(onEvent)
    const a = JSON.stringify({
      type: "item.started",
      item: { type: "command_execution", command: "npm test" },
    })
    const b = JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: "passed" },
    })
    feed(obs, `${a}\n${b}\n`)
    assert.ok(events.includes("  command: npm test"))
    assert.ok(events.includes("  passed"))
  })

  it("handles lines split across chunks", () => {
    const { events, onEvent } = captureEvents()
    const obs = createCodexStreamObserver(onEvent)
    const line = JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: "split" },
    })
    const mid = Math.floor(line.length / 2)
    feed(obs, line.slice(0, mid), line.slice(mid) + "\n")
    assert.ok(events.includes("  split"))
  })

  it("preserves malformed JSON in bufferedStdout", () => {
    const { events, onEvent } = captureEvents()
    const obs = createCodexStreamObserver(onEvent)
    feed(obs, "junk\n")
    assert.equal(events.length, 0)
    assert.equal(obs.bufferedStdout, "junk")
    assert.equal(obs.streamedStdout, false)
  })

  it("flush emits a trailing line without newline", () => {
    const { events, onEvent } = captureEvents()
    const obs = createCodexStreamObserver(onEvent)
    const line = JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: "tail" },
    })
    obs.consumeStdoutChunk(line)
    assert.equal(events.length, 0)
    obs.flush()
    assert.ok(events.includes("  tail"))
  })

  it("ignores unknown event types silently", () => {
    const { events, onEvent } = captureEvents()
    const obs = createCodexStreamObserver(onEvent)
    feed(
      obs,
      `${JSON.stringify({ type: "something_new", item: { type: "mystery" } })}\n`,
    )
    assert.equal(events.length, 0)
    assert.equal(obs.streamedStdout, false)
  })
})

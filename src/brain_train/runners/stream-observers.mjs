// ---------------------------------------------------------------------------
// Stream observers for loop CLI runners.
//
// Each runtime (claude, codex) emits a line-delimited JSON stream while it
// works. This module parses those streams and calls `onEvent(line)` with
// readable progress text. Observers are the contract surface between btrain
// and a specific runtime — if the runtime changes its event shape, the
// observer breaks first. Pin tests in test/runners/*.pin.test.mjs exercise
// each observer against a fixture stream to catch drift early.
//
// Exported so tests can import directly. core.mjs currently inlines these
// same functions; when that file unlocks, import from here and delete the
// duplicates.
// ---------------------------------------------------------------------------

export const MAX_LOOP_LOG_OUTPUT_LINES = 40

export function summarizeLoopProgressText(text, maxLength = 240) {
  const compact = String(text || "").replace(/\s+/g, " ").trim()
  if (!compact) {
    return ""
  }
  return compact.length <= maxLength ? compact : `${compact.slice(0, maxLength - 3)}...`
}

export function formatClaudeToolUse(block) {
  const summarySource =
    typeof block?.input?.command === "string" && block.input.command.trim()
      ? block.input.command
      : JSON.stringify(block?.input || {})

  const summary = summarizeLoopProgressText(summarySource)
  return summary ? `tool ${block.name}: ${summary}` : `tool ${block.name}`
}

export function formatClaudeToolResult(toolResult) {
  const primaryOutput =
    typeof toolResult?.stdout === "string" && toolResult.stdout.trim()
      ? toolResult.stdout
      : typeof toolResult?.stderr === "string" && toolResult.stderr.trim()
        ? toolResult.stderr
        : ""

  if (primaryOutput) {
    return `tool result: ${summarizeLoopProgressText(primaryOutput)}`
  }
  if (toolResult?.interrupted) {
    return "tool result: interrupted"
  }
  return "tool result: completed"
}

export function summarizeCodexCommand(commandText) {
  const raw = String(commandText || "").trim()
  if (!raw) {
    return ""
  }

  const shellMatch = /^\S+\s+-lc\s+'([\s\S]+)'$/.exec(raw)
  if (shellMatch?.[1]) {
    return summarizeLoopProgressText(shellMatch[1].replace(/\\'/g, "'"))
  }

  return summarizeLoopProgressText(raw)
}

export function formatCodexCommandOutput(item) {
  const output =
    typeof item?.aggregated_output === "string" && item.aggregated_output.trim()
      ? item.aggregated_output
      : ""

  if (!output) {
    return item?.exit_code === 0 ? "command completed" : `command exited ${item?.exit_code ?? 1}`
  }

  return summarizeLoopProgressText(output)
}

export function emitLoopOutput(onEvent, label, text) {
  if (!text) {
    return
  }

  const lines = text
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)

  if (lines.length === 0) {
    return
  }

  onEvent(label)
  for (const line of lines.slice(0, MAX_LOOP_LOG_OUTPUT_LINES)) {
    onEvent(`  ${line}`)
  }
  if (lines.length > MAX_LOOP_LOG_OUTPUT_LINES) {
    onEvent(`  ... truncated ${lines.length - MAX_LOOP_LOG_OUTPUT_LINES} more lines`)
  }
}

export function createClaudeStreamObserver(onEvent) {
  let stdoutBuffer = ""
  let stderrBuffer = ""
  const rawStdoutLines = []
  let streamedStdout = false
  let lastAssistantText = ""

  function emitProgressLine(line) {
    const text = summarizeLoopProgressText(line)
    if (!text) {
      return
    }
    streamedStdout = true
    emitLoopOutput(onEvent, "agent progress:", text)
  }

  function handleStdoutLine(line) {
    const trimmed = line.trim()
    if (!trimmed) {
      return
    }

    let payload
    try {
      payload = JSON.parse(trimmed)
    } catch {
      rawStdoutLines.push(trimmed)
      return
    }

    if (payload.type === "assistant") {
      for (const block of payload.message?.content || []) {
        if (block?.type === "tool_use" && block?.name) {
          emitProgressLine(formatClaudeToolUse(block))
        } else if (block?.type === "text" && block?.text?.trim()) {
          lastAssistantText = summarizeLoopProgressText(block.text)
          emitProgressLine(lastAssistantText)
        }
      }
      return
    }

    if (payload.type === "user" && payload.tool_use_result) {
      emitProgressLine(formatClaudeToolResult(payload.tool_use_result))
      return
    }

    if (
      payload.type === "result" &&
      payload.subtype === "success" &&
      typeof payload.result === "string" &&
      payload.result.trim()
    ) {
      const resultSummary = summarizeLoopProgressText(payload.result)
      if (resultSummary && resultSummary !== lastAssistantText) {
        emitProgressLine(`result: ${resultSummary}`)
      }
      return
    }

    if (
      payload.type === "result" &&
      payload.is_error &&
      typeof payload.result === "string" &&
      payload.result.trim()
    ) {
      emitProgressLine(`error: ${payload.result}`)
    }
  }

  function consumeStdoutChunk(chunk) {
    stdoutBuffer += chunk
    let newlineIndex = stdoutBuffer.indexOf("\n")
    while (newlineIndex !== -1) {
      const line = stdoutBuffer.slice(0, newlineIndex)
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1)
      handleStdoutLine(line)
      newlineIndex = stdoutBuffer.indexOf("\n")
    }
  }

  function consumeStderrChunk(chunk) {
    stderrBuffer += chunk
  }

  function flush() {
    if (stdoutBuffer.trim()) {
      handleStdoutLine(stdoutBuffer)
      stdoutBuffer = ""
    }
  }

  return {
    consumeStdoutChunk,
    consumeStderrChunk,
    flush,
    get streamedStdout() {
      return streamedStdout
    },
    get bufferedStdout() {
      return rawStdoutLines.join("\n")
    },
    get bufferedStderr() {
      return stderrBuffer.trim()
    },
  }
}

export function createCodexStreamObserver(onEvent) {
  let stdoutBuffer = ""
  let stderrBuffer = ""
  const rawStdoutLines = []
  let streamedStdout = false

  function emitProgressLine(line) {
    const text = summarizeLoopProgressText(line)
    if (!text) {
      return
    }
    streamedStdout = true
    emitLoopOutput(onEvent, "agent progress:", text)
  }

  function handleStdoutLine(line) {
    const trimmed = line.trim()
    if (!trimmed) {
      return
    }

    let payload
    try {
      payload = JSON.parse(trimmed)
    } catch {
      rawStdoutLines.push(trimmed)
      return
    }

    if (payload.type === "item.started" && payload.item?.type === "command_execution") {
      const command = summarizeCodexCommand(payload.item.command)
      emitProgressLine(command ? `command: ${command}` : "command started")
      return
    }

    if (payload.type === "item.completed" && payload.item?.type === "command_execution") {
      const command = summarizeCodexCommand(payload.item.command)
      const output = formatCodexCommandOutput(payload.item)
      emitProgressLine(command ? `command finished: ${command}` : "command finished")
      if (output) {
        emitProgressLine(`command result: ${output}`)
      }
      return
    }

    if (payload.type === "item.completed" && payload.item?.type === "agent_message" && payload.item?.text?.trim()) {
      emitProgressLine(payload.item.text)
      return
    }

    if (payload.type === "error" && payload.message) {
      emitProgressLine(`error: ${payload.message}`)
    }
  }

  function consumeStdoutChunk(chunk) {
    stdoutBuffer += chunk
    let newlineIndex = stdoutBuffer.indexOf("\n")
    while (newlineIndex !== -1) {
      const line = stdoutBuffer.slice(0, newlineIndex)
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1)
      handleStdoutLine(line)
      newlineIndex = stdoutBuffer.indexOf("\n")
    }
  }

  function consumeStderrChunk(chunk) {
    stderrBuffer += chunk
  }

  function flush() {
    if (stdoutBuffer.trim()) {
      handleStdoutLine(stdoutBuffer)
      stdoutBuffer = ""
    }
  }

  return {
    consumeStdoutChunk,
    consumeStderrChunk,
    flush,
    get streamedStdout() {
      return streamedStdout
    },
    get bufferedStdout() {
      return rawStdoutLines.join("\n")
    },
    get bufferedStderr() {
      return stderrBuffer.trim()
    },
  }
}

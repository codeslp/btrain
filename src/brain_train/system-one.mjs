import { performance } from "node:perf_hooks"
import fs from "node:fs/promises"
import { constants as fsConstants } from "node:fs"
import os from "node:os"
import path from "node:path"

const DEFAULT_ENDPOINT = "https://api.typesafe.ai/v1/systemone"
const DEFAULT_MODEL = "jev-latest"
const DEFAULT_TIMEOUT_MS = 2000
const MIN_TIMEOUT_MS = 100
const MAX_TIMEOUT_MS = 10000
const MAX_QUESTIONS = 64
const MAX_REQUEST_BYTES = 256 * 1024
const MAX_RESPONSE_BYTES = 1024 * 1024

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : ""
}

function safeMetadataText(value, fallback = "") {
  const text = normalizeText(value).replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
  return text.slice(0, 128) || fallback
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(String(value ?? ""), 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(maximum, Math.max(minimum, parsed))
}

export function readSystemOneRuntimeConfig(env = process.env) {
  const requestedMode = normalizeText(env.BTRAIN_JEV_MODE).toLowerCase() || "assist"
  const mode = new Set(["off", "shadow", "assist"]).has(requestedMode) ? requestedMode : "off"
  const apiKey = normalizeText(env.BTRAIN_JEV_API_KEY || env.JEV_API_KEY || env.TYPESAFE_API_KEY)
  const endpoint = normalizeText(env.BTRAIN_JEV_ENDPOINT) || DEFAULT_ENDPOINT
  const model = normalizeText(env.BTRAIN_JEV_MODEL) || DEFAULT_MODEL
  const timeoutMs = boundedInteger(env.BTRAIN_JEV_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS)
  const enabled = mode !== "off" && !!apiKey
  const reason = mode === "off"
    ? (requestedMode === "off" ? "mode-off" : "invalid-mode")
    : apiKey
      ? "enabled"
      : "missing-api-key"

  return { mode, enabled, apiKey, endpoint, model, timeoutMs, reason }
}

// Credentials belong to the current user's global btrain config, never a repository.
// Explicit environment keys take precedence; off/invalid modes do not read a file.
export async function loadSystemOneRuntimeConfig(env = process.env) {
  const config = readSystemOneRuntimeConfig(env)
  if (config.reason !== "missing-api-key") return config
  const home = normalizeText(env.BRAIN_TRAIN_HOME) || path.join(os.homedir(), ".btrain")
  const credentialPath = normalizeText(env.BTRAIN_JEV_CREDENTIALS_FILE) || path.join(home, "jev.json")
  let file
  try {
    file = await fs.open(path.resolve(credentialPath), fsConstants.O_RDONLY
      | (fsConstants.O_NOFOLLOW || 0) | (fsConstants.O_NONBLOCK || 0))
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > 4096) return { ...config, reason: "invalid-credential-file" }
    if (process.platform !== "win32" && ((stat.mode & 0o077) !== 0
      || (typeof process.getuid === "function" && stat.uid !== process.getuid()))) {
      return { ...config, reason: "insecure-credential-file" }
    }
    const buffer = Buffer.alloc(4097)
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
    if (bytesRead > 4096) return { ...config, reason: "invalid-credential-file" }
    const stored = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"))
    if (!stored || typeof stored !== "object" || Array.isArray(stored)
      || typeof stored.apiKey !== "string" || !stored.apiKey.trim()) {
      return { ...config, reason: "invalid-credential-file" }
    }
    return readSystemOneRuntimeConfig({ ...env, BTRAIN_JEV_API_KEY: stored.apiKey })
  } catch (error) {
    return error.code === "ENOENT" ? config : { ...config, reason: "invalid-credential-file" }
  } finally {
    await file?.close().catch(() => {})
  }
}

function requestIssue(request) {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    return "request must be an object"
  }
  const questions = request.questions
  if (!questions || typeof questions !== "object" || Array.isArray(questions)) {
    return "questions must be an object"
  }
  const entries = Object.entries(questions)
  if (entries.length < 1 || entries.length > MAX_QUESTIONS) {
    return `questions must contain between 1 and ${MAX_QUESTIONS} entries`
  }
  for (const [id, question] of entries) {
    if (!question || typeof question !== "object" || Array.isArray(question)) {
      return `question ${id} must be an object`
    }
    if (!normalizeText(question.instructions)) {
      return `question ${id} requires instructions`
    }
    if (question.type === "choice") {
      const count = question.criteria && typeof question.criteria === "object" && !Array.isArray(question.criteria)
        ? Object.keys(question.criteria).length
        : 0
      if (count < 2 || count > 255) return `choice question ${id} must contain between 2 and 255 options`
      continue
    }
    if (question.type === "score") {
      const count = Array.isArray(question.criteria) ? question.criteria.length : 0
      if (count < 2 || count > 10) return `score question ${id} must contain between 2 and 10 levels`
      continue
    }
    if (question.type !== "noul") return `question ${id} has an unsupported type`
  }
  return ""
}

function validResponse(body) {
  return !!(
    body
    && typeof body === "object"
    && !Array.isArray(body)
    && typeof body.answers === "object"
    && body.answers !== null
    && !Array.isArray(body.answers)
  )
}

function endpointIssue(value) {
  try {
    const parsed = new URL(value)
    if (parsed.protocol === "https:") return ""
    if (parsed.protocol === "http:" && new Set(["127.0.0.1", "localhost", "[::1]"]).has(parsed.hostname)) return ""
    return "System One endpoints must use HTTPS unless they are local."
  } catch {
    return "System One endpoint is not a valid URL."
  }
}

function failure(reason, message, startedAt) {
  return {
    ok: false,
    reason,
    message,
    latencyMs: Math.max(0, Math.round((performance.now() - startedAt) * 10) / 10),
  }
}

function httpFailureReason(status) {
  if (status === 401 || status === 403) return "authentication-error"
  if (status === 429) return "rate-limit"
  if (status >= 500 && status <= 599) return "provider-error"
  return "http-error"
}

async function readBoundedResponseBody(response) {
  const reader = response.body?.getReader?.()
  if (!reader) return { invalid: true }

  const decoder = new TextDecoder()
  const chunks = []
  let bytes = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!(value instanceof Uint8Array)) return { invalid: true }
      bytes += value.byteLength
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel("response-size-limit")
        return { oversized: true }
      }
      chunks.push(decoder.decode(value, { stream: true }))
    }
    chunks.push(decoder.decode())
    return { text: chunks.join("") }
  } finally {
    reader.releaseLock()
  }
}

export function createSystemOneClient({
  apiKey = "",
  endpoint = DEFAULT_ENDPOINT,
  model = DEFAULT_MODEL,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = fetch,
} = {}) {
  const normalizedKey = normalizeText(apiKey)
  const normalizedEndpoint = normalizeText(endpoint) || DEFAULT_ENDPOINT
  const normalizedModel = normalizeText(model) || DEFAULT_MODEL
  const boundedTimeout = boundedInteger(timeoutMs, DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS)

  return {
    async decide(request) {
      if (!normalizedKey) {
        return {
          ok: false,
          reason: "disabled",
          message: "System One is disabled because no API key is configured.",
          latencyMs: 0,
        }
      }

      const startedAt = performance.now()
      const invalidEndpoint = endpointIssue(normalizedEndpoint)
      if (invalidEndpoint) return failure("invalid-endpoint", invalidEndpoint, startedAt)
      const issue = requestIssue(request)
      if (issue) return failure("invalid-request", issue, startedAt)
      let requestBody
      try {
        requestBody = JSON.stringify({ ...request, model: normalizedModel })
      } catch {
        return failure("invalid-request", "System One request is not serializable.", startedAt)
      }
      if (Buffer.byteLength(requestBody) > MAX_REQUEST_BYTES) {
        return failure("invalid-request", "System One request exceeds the size limit.", startedAt)
      }

      const controller = new AbortController()
      let timeout
      try {
        const operation = (async () => {
          const response = await fetchImpl(normalizedEndpoint, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${normalizedKey}`,
            },
            body: requestBody,
            signal: controller.signal,
            redirect: "error",
          })
          if (!response?.ok) {
            try {
              await response.body?.cancel?.("http-error")
            } catch {
              // Preserve the provider HTTP error when body cleanup itself fails.
            }
            return { response, body: null }
          }
          const contentLength = Number.parseInt(response.headers?.get?.("content-length") || "", 10)
          if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
            await response.body?.cancel?.("response-size-limit")
            return { response, oversized: true }
          }
          const boundedBody = await readBoundedResponseBody(response)
          if (boundedBody.oversized) return { response, oversized: true }
          if (boundedBody.invalid) return { response, invalidBody: true }
          let body = null
          try {
            body = JSON.parse(boundedBody.text)
          } catch {
            // The common invalid-response path handles malformed JSON.
          }
          return { response, body }
        })()
        const deadline = new Promise((_, reject) => {
          timeout = setTimeout(() => {
            controller.abort(new DOMException("Timed out", "TimeoutError"))
            reject(new DOMException("Timed out", "TimeoutError"))
          }, boundedTimeout)
        })
        const { response, body, oversized, invalidBody } = await Promise.race([operation, deadline])
        if (!response?.ok) {
          return failure(
            httpFailureReason(response?.status),
            `System One returned HTTP ${response?.status || "unknown"}.`,
            startedAt,
          )
        }
        if (oversized) return failure("invalid-response", "System One response exceeds the size limit.", startedAt)
        if (invalidBody) return failure("invalid-response", "System One returned an unreadable response body.", startedAt)
        if (!validResponse(body)) {
          return failure("invalid-response", "System One returned an invalid response shape.", startedAt)
        }
        return {
          ok: true,
          model: safeMetadataText(body.model, safeMetadataText(normalizedModel, DEFAULT_MODEL)),
          answers: body.answers,
          usage: body.usage && typeof body.usage === "object" ? body.usage : {},
          latencyMs: Math.max(0, Math.round((performance.now() - startedAt) * 10) / 10),
        }
      } catch (error) {
        if (controller.signal.aborted || error?.name === "AbortError" || error?.name === "TimeoutError") {
          return failure("timeout", `System One exceeded the ${boundedTimeout} ms timeout.`, startedAt)
        }
        return failure("network-error", "System One could not be reached.", startedAt)
      } finally {
        clearTimeout(timeout)
      }
    },
  }
}

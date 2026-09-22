import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  createSystemOneClient,
  readSystemOneRuntimeConfig,
} from "../src/brain_train/system-one.mjs"

describe("System One runtime configuration", () => {
  it("is disabled by default and requires an explicit mode", () => {
    assert.deepEqual(readSystemOneRuntimeConfig({}), {
      mode: "off",
      enabled: false,
      apiKey: "",
      endpoint: "https://api.typesafe.ai/v1/systemone",
      model: "jev-latest",
      timeoutMs: 2000,
      reason: "mode-off",
    })
  })

  it("keeps shadow and assist disabled when the key is missing", () => {
    const shadow = readSystemOneRuntimeConfig({ BTRAIN_JEV_MODE: "shadow" })
    const assist = readSystemOneRuntimeConfig({ BTRAIN_JEV_MODE: "assist" })

    assert.equal(shadow.enabled, false)
    assert.equal(shadow.reason, "missing-api-key")
    assert.equal(assist.enabled, false)
    assert.equal(assist.reason, "missing-api-key")
  })

  it("preserves an invalid mode as an operator-visible configuration failure", () => {
    const config = readSystemOneRuntimeConfig({ BTRAIN_JEV_MODE: "asist", BTRAIN_JEV_API_KEY: "key" })

    assert.equal(config.mode, "off")
    assert.equal(config.enabled, false)
    assert.equal(config.reason, "invalid-mode")
  })

  it("bounds the configured timeout and accepts the shared JEV key name", () => {
    const config = readSystemOneRuntimeConfig({
      BTRAIN_JEV_MODE: "assist",
      JEV_API_KEY: "configured-test-key",
      BTRAIN_JEV_TIMEOUT_MS: "90000",
      BTRAIN_JEV_MODEL: "jev-1.13.0",
    })

    assert.equal(config.enabled, true)
    assert.equal(config.timeoutMs, 10000)
    assert.equal(config.model, "jev-1.13.0")
  })
})

describe("System One client", () => {
  it("returns typed answers without exposing transport details to callers", async () => {
    const apiKey = "configured-test-key"
    let request
    const client = createSystemOneClient({
      apiKey,
      fetchImpl: async (url, options) => {
        request = { url, options }
        return new Response(JSON.stringify({
          model: "jev-1.13.0",
          answers: {
            signal: {
              type: "choice",
              choice: "feedback",
              confidence: 0.94,
              probabilities: { clear: 0.01, feedback: 0.97, unavailable: 0.01, uncertain: 0.01 },
            },
          },
          usage: { input_tokens: 42, output_tokens: 4 },
        }), { status: 200, headers: { "content-type": "application/json" } })
      },
    })

    const result = await client.decide({
      state: { text: "One issue remains." },
      questions: {
        signal: {
          type: "choice",
          instructions: "What is the review result?",
          criteria: { clear: "No changes", feedback: "Changes needed", unavailable: "No review", uncertain: "No verdict" },
        },
      },
    })

    assert.equal(result.ok, true)
    assert.equal(result.model, "jev-1.13.0")
    assert.equal(result.answers.signal.choice, "feedback")
    assert.equal(request.url, "https://api.typesafe.ai/v1/systemone")
    assert.equal(request.options.headers.authorization, `Bearer ${apiKey}`)
    assert.equal(JSON.parse(request.options.body).model, "jev-latest")
  })

  it("fails closed without making a request when configuration is disabled", async () => {
    let called = false
    const client = createSystemOneClient({
      apiKey: "",
      fetchImpl: async () => {
        called = true
        throw new Error("must not run")
      },
    })

    assert.deepEqual(await client.decide({ state: "x", questions: {} }), {
      ok: false,
      reason: "disabled",
      message: "System One is disabled because no API key is configured.",
      latencyMs: 0,
    })
    assert.equal(called, false)
  })

  it("converts provider, response, and timeout failures into safe results", async () => {
    const request = {
      state: "x",
      questions: { signal: { type: "noul", instructions: "Is this a review verdict?", criteria: null } },
    }
    const provider = createSystemOneClient({
      apiKey: "configured-test-key",
      fetchImpl: async () => new Response("not authorized", { status: 401 }),
    })
    const malformed = createSystemOneClient({
      apiKey: "configured-test-key",
      fetchImpl: async () => new Response(JSON.stringify({ model: "jev-1.13.0", answers: null }), { status: 200 }),
    })
    const timeout = createSystemOneClient({
      apiKey: "configured-test-key",
      timeoutMs: 10,
      fetchImpl: async (_url, options) => new Promise((resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(options.signal.reason))
      }),
    })

    assert.equal((await provider.decide(request)).reason, "http-error")
    assert.equal((await malformed.decide(request)).reason, "invalid-response")
    assert.equal((await timeout.decide(request)).reason, "timeout")
  })

  it("cancels a non-success response body before returning the HTTP error", async () => {
    let cancelled = false
    const stream = new ReadableStream({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode("still failing"))
      },
      cancel() {
        cancelled = true
      },
    })
    const client = createSystemOneClient({
      apiKey: "configured-test-key",
      fetchImpl: async () => new Response(stream, { status: 503 }),
    })

    const result = await client.decide({
      state: "x",
      questions: { signal: { type: "noul", instructions: "Is this a verdict?", criteria: null } },
    })

    assert.equal(result.reason, "http-error")
    assert.equal(cancelled, true)
  })

  it("rejects requests outside the documented question limits before transport", async () => {
    let called = false
    const client = createSystemOneClient({
      apiKey: "configured-test-key",
      fetchImpl: async () => {
        called = true
        return new Response("{}", { status: 200 })
      },
    })

    const result = await client.decide({
      state: "x",
      questions: {
        signal: { type: "choice", instructions: "Choose", criteria: { only: "one option" } },
      },
    })

    assert.equal(result.reason, "invalid-request")
    assert.equal(called, false)
  })

  it("does not send a bearer credential to a non-local HTTP endpoint", async () => {
    let called = false
    const client = createSystemOneClient({
      apiKey: "configured-test-key",
      endpoint: "http://example.test/v1/systemone",
      fetchImpl: async () => {
        called = true
        return new Response("{}", { status: 200 })
      },
    })
    const result = await client.decide({
      state: "x",
      questions: { signal: { type: "noul", instructions: "Is this a verdict?", criteria: null } },
    })

    assert.equal(result.reason, "invalid-endpoint")
    assert.equal(called, false)
  })

  it("allows IPv6 loopback HTTP endpoints but rejects other IPv6 hosts", async () => {
    const request = {
      state: "x",
      questions: { signal: { type: "noul", instructions: "Is this a verdict?", criteria: null } },
    }
    for (const [host, allowed] of [
      ["[::1]", true],
      ["[0:0:0:0:0:0:0:1]", true],
      ["[::]", false],
      ["[::2]", false],
      ["[2001:db8::1]", false],
    ]) {
      let calls = 0
      const client = createSystemOneClient({
        apiKey: "configured-test-key",
        endpoint: `http://${host}:8080/v1/systemone`,
        fetchImpl: async () => {
          calls += 1
          return new Response(JSON.stringify({ answers: { signal: { noul: 0.9 } } }))
        },
      })

      const result = await client.decide(request)

      assert.equal(result.ok, allowed, host)
      assert.equal(calls, allowed ? 1 : 0, host)
      if (!allowed) assert.equal(result.reason, "invalid-endpoint", host)
    }
  })

  it("rejects redirects so review text stays on the configured origin", async () => {
    let redirect
    const client = createSystemOneClient({
      apiKey: "configured-test-key",
      fetchImpl: async (_url, options) => {
        redirect = options.redirect
        return new Response("redirected", { status: 307 })
      },
    })
    const result = await client.decide({
      state: { reviewComment: "private review text" },
      questions: { signal: { type: "noul", instructions: "Is this a verdict?", criteria: null } },
    })

    assert.equal(redirect, "error")
    assert.equal(result.reason, "http-error")
  })

  it("enforces its deadline when the transport ignores AbortSignal", async () => {
    const client = createSystemOneClient({
      apiKey: "configured-test-key",
      timeoutMs: 100,
      fetchImpl: async () => new Promise(() => {}),
    })
    const request = {
      state: "x",
      questions: { signal: { type: "noul", instructions: "Is this a verdict?", criteria: null } },
    }
    const externalWatchdog = new Promise((resolve) => setTimeout(() => resolve({ reason: "external-timeout" }), 300))

    const result = await Promise.race([client.decide(request), externalWatchdog])
    assert.equal(result.reason, "timeout")
  })

  it("bounds request and response bodies", async () => {
    let requestCalls = 0
    const requestClient = createSystemOneClient({
      apiKey: "configured-test-key",
      fetchImpl: async () => {
        requestCalls += 1
        return new Response("{}", { status: 200 })
      },
    })
    const requestResult = await requestClient.decide({
      state: { reviewComment: "x".repeat(300_000) },
      questions: { signal: { type: "noul", instructions: "Is this a verdict?", criteria: null } },
    })
    assert.equal(requestResult.reason, "invalid-request")
    assert.equal(requestCalls, 0)

    const responseClient = createSystemOneClient({
      apiKey: "configured-test-key",
      fetchImpl: async () => new Response("x".repeat(1_100_000), { status: 200 }),
    })
    const responseResult = await responseClient.decide({
      state: "x",
      questions: { signal: { type: "noul", instructions: "Is this a verdict?", criteria: null } },
    })
    assert.equal(responseResult.reason, "invalid-response")
  })

  it("cancels an oversized chunked response before buffering the full stream", async () => {
    let pulls = 0
    let cancelled = false
    const stream = new ReadableStream({
      pull(controller) {
        pulls += 1
        if (pulls <= 2) controller.enqueue(new TextEncoder().encode("x".repeat(600_000)))
      },
      cancel() {
        cancelled = true
      },
    })
    const client = createSystemOneClient({
      apiKey: "configured-test-key",
      timeoutMs: 500,
      fetchImpl: async () => new Response(stream, { status: 200 }),
    })
    const result = await client.decide({
      state: "x",
      questions: { signal: { type: "noul", instructions: "Is this a verdict?", criteria: null } },
    })

    assert.equal(result.reason, "invalid-response")
    assert.equal(cancelled, true)
    assert.ok(pulls <= 3)
  })

  it("turns non-serializable requests into safe validation failures", async () => {
    let calls = 0
    const client = createSystemOneClient({
      apiKey: "configured-test-key",
      fetchImpl: async () => {
        calls += 1
        return new Response("{}", { status: 200 })
      },
    })
    const request = {
      state: {},
      questions: { signal: { type: "noul", instructions: "Is this a verdict?", criteria: null } },
    }
    request.state.circular = request

    const result = await client.decide(request)
    assert.equal(result.reason, "invalid-request")
    assert.equal(calls, 0)
  })

  it("sanitizes provider-controlled model metadata", async () => {
    const client = createSystemOneClient({
      apiKey: "configured-test-key",
      fetchImpl: async () => new Response(JSON.stringify({
        model: "\u001b[31mjev-1.13.0\u0007",
        answers: { signal: { type: "noul", noul: 0.9 } },
      }), { status: 200 }),
    })
    const result = await client.decide({
      state: "x",
      questions: { signal: { type: "noul", instructions: "Is this a verdict?", criteria: null } },
    })

    assert.equal(result.ok, true)
    assert.doesNotMatch(result.model, /[\u0000-\u001f\u007f-\u009f]/)
    assert.ok(result.model.length <= 128)
  })
})

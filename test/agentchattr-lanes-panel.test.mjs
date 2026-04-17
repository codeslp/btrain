import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import vm from "node:vm"

const CHAT_JS_PATH = path.resolve("agentchattr/static/chat.js")
const CHANNELS_JS_PATH = path.resolve("agentchattr/static/channels.js")

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
}

function createElement(tagName = "div") {
  let textContent = ""
  let innerHTML = ""
  const styleStore = {}
  const classNames = new Set()
  const syncClassName = (target) => {
    target.className = Array.from(classNames).join(" ")
  }
  const el = {
    tagName: String(tagName).toUpperCase(),
    style: {
      ...styleStore,
      setProperty(name, value) {
        styleStore[name] = String(value)
      },
      getPropertyValue(name) {
        return styleStore[name] || ""
      },
    },
    dataset: {},
    children: [],
    className: "",
    appendChild(child) {
      this.children.push(child)
      return child
    },
    prepend(child) {
      this.children.unshift(child)
      return child
    },
    insertBefore(child, beforeChild) {
      const index = this.children.indexOf(beforeChild)
      if (index === -1) {
        this.children.push(child)
      } else {
        this.children.splice(index, 0, child)
      }
      return child
    },
    remove() {},
    after() {},
    querySelector() {
      return null
    },
    querySelectorAll() {
      return []
    },
    closest() {
      return null
    },
    classList: {
      add(...names) {
        names.forEach((name) => classNames.add(String(name)))
        syncClassName(el)
      },
      remove(...names) {
        names.forEach((name) => classNames.delete(String(name)))
        syncClassName(el)
      },
      toggle(name) {
        const key = String(name)
        if (classNames.has(key)) {
          classNames.delete(key)
          syncClassName(el)
          return false
        }
        classNames.add(key)
        syncClassName(el)
        return true
      },
      contains(name) {
        return classNames.has(String(name))
      },
    },
    set innerHTML(value) {
      innerHTML = String(value)
      if (!innerHTML) this.children = []
    },
    get innerHTML() {
      return innerHTML
    },
    set textContent(value) {
      textContent = String(value)
      innerHTML = escapeHtml(textContent)
    },
    get textContent() {
      return textContent
    },
  }
  return el
}

function buildChannelsHarness() {
  const elements = new Map([
    ["lane-pills-bar", createElement("div")],
    ["repo-tabs", createElement("div")],
    ["lane-tabs", createElement("div")],
    ["lane-divider", createElement("div")],
    ["channel-tabs", createElement("div")],
    ["channel-add-btn", createElement("button")],
  ])

  const document = {
    getElementById(id) {
      return elements.get(id) || null
    },
    createElement(tagName) {
      return createElement(tagName)
    },
    querySelector() {
      return null
    },
    querySelectorAll() {
      return []
    },
  }

  const window = {
    activeChannel: "general",
    channelList: ["general", "btrain/agents", "cgraph/agents"],
    channelUnread: {},
    laneChannels: ["btrain/a", "btrain/b", "cgraph/a", "cgraph/b"],
    agentConfig: {
      "claude-4": { label: "Claude 4", repo: "/repos/btrain", state: "active", color: "#ff00ff" },
      "codex": { label: "Codex", repo: "/repos/btrain", state: "active", color: "#00f0ff" },
      "claude-3": { label: "Claude 3", repo: "/repos/cgraph", state: "active", color: "#ff00ff" },
    },
    btrainLanes: {
      lanes: [
        { _laneId: "a", _repo: "btrain", status: "in-progress", owner: "codex", reviewer: "claude" },
        { _laneId: "b", _repo: "btrain", status: "needs-review", owner: "codex", reviewer: "claude" },
        { _laneId: "a", _repo: "cgraph", status: "in-progress", owner: "claude", reviewer: "codex" },
        { _laneId: "b", _repo: "cgraph", status: "resolved", owner: "claude", reviewer: "codex" },
      ],
      repos: [
        {
          name: "btrain",
          path: "/repos/btrain",
          lanes: [
            { status: "in-progress" },
            { status: "needs-review" },
          ],
        },
        {
          name: "cgraph",
          path: "/repos/cgraph",
          lanes: [
            { status: "resolved" },
          ],
        },
      ],
    },
    getRepoNames() {
      return ["btrain", "cgraph"]
    },
    getRepoForChannel(channelName) {
      if (typeof channelName !== "string" || !channelName.includes("/")) return ""
      return channelName.split("/")[0]
    },
  }
  window.window = window

  const context = vm.createContext({
    console,
    window,
    document,
    escapeHtml,
    switchChannel() {},
    openPath() {},
  })

  return { context, elements }
}

function buildChatHarness() {
  const elements = new Map([
    ["lanes-panel-cards", createElement("div")],
    ["loading-indicator", createElement("div")],
    ["messages", createElement("div")],
  ])

  class FakeWebSocket {
    static instances = []

    constructor(url) {
      this.url = url
      this.onopen = null
      this.onmessage = null
      this.onclose = null
      this.onerror = null
      FakeWebSocket.instances.push(this)
    }

    close() {}
  }

  const document = {
    getElementById(id) {
      return elements.get(id) || null
    },
    createElement(tagName) {
      return createElement(tagName)
    },
    addEventListener() {},
    removeEventListener() {},
    querySelector() {
      return null
    },
    querySelectorAll() {
      return []
    },
    hasFocus() {
      return false
    },
  }

  const localStorageData = new Map()
  const localStorage = {
    getItem(key) {
      return localStorageData.has(key) ? localStorageData.get(key) : null
    },
    setItem(key, value) {
      localStorageData.set(key, String(value))
    },
    removeItem(key) {
      localStorageData.delete(key)
    },
    clear() {
      localStorageData.clear()
    },
  }

  const window = {
    __SESSION_TOKEN__: "test-token",
    customRoles: [],
    addEventListener() {},
    removeEventListener() {},
  }
  window.window = window

  const context = vm.createContext({
    console,
    setTimeout,
    clearTimeout,
    setInterval: () => 1,
    clearInterval: () => {},
    requestAnimationFrame: (fn) => fn(),
    localStorage,
    document,
    window,
    location: { protocol: "http:", host: "localhost:8300", reload() {} },
    WebSocket: FakeWebSocket,
    Hub: { emit() {} },
    Store: { set() {} },
    Audio: class {
      play() {
        return Promise.resolve()
      }
    },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    navigator: {},
    URL,
    URLSearchParams,
    encodeURIComponent,
  })

  return { context, elements, FakeWebSocket }
}

test("btrain lane updates render left-rail lane cards", async () => {
  const source = await fs.readFile(CHAT_JS_PATH, "utf8")
  const { context, elements, FakeWebSocket } = buildChatHarness()

  vm.runInContext(source, context, { filename: CHAT_JS_PATH })

  context.renderChannelTabs = () => {}
  context.renderLaneHeader = () => {}
  context.connectWebSocket()

  const socket = FakeWebSocket.instances.at(-1)
  assert.ok(socket, "expected connectWebSocket to create a WebSocket")

  socket.onmessage({
    data: JSON.stringify({
      type: "btrain_lanes",
      data: {
        lanes: [
          {
            _laneId: "c",
            status: "resolved",
            task: "Wrap up release notes",
            owner: "claude",
            reviewer: "codex",
          },
          {
            _laneId: "a",
            status: "in-progress",
            task: "Fix left rail rendering",
            owner: "codex",
            reviewer: "claude",
            lockedFiles: ["agentchattr/static/chat.js"],
            nextAction: "Continue debugging the left rail",
          },
          {
            _laneId: "b",
            status: "needs-review",
            task: "Verify dashboard handoff",
            owner: "codex",
            reviewer: "claude",
          },
        ],
      },
    }),
  })

  const panelMarkup = elements.get("lanes-panel-cards").innerHTML
  const laneAIndex = panelMarkup.indexOf("LANE A")
  const laneBIndex = panelMarkup.indexOf("LANE B")
  const laneCIndex = panelMarkup.indexOf("LANE C")

  assert.ok(laneAIndex >= 0, panelMarkup || "expected lane A to render")
  assert.ok(laneBIndex >= 0, panelMarkup || "expected lane B to render")
  assert.ok(laneCIndex >= 0, panelMarkup || "expected lane C to render")
  assert.ok(laneAIndex < laneBIndex, panelMarkup || "expected lane A before lane B")
  assert.ok(laneBIndex < laneCIndex, panelMarkup || "expected lane B before lane C")
  assert.match(panelMarkup, /Fix left rail rendering/, panelMarkup || "expected the lane task to render")
})

test("repo tabs show assigned agents for each repo", async () => {
  const source = await fs.readFile(CHANNELS_JS_PATH, "utf8")
  const { context, elements } = buildChannelsHarness()

  vm.runInContext(source, context, { filename: CHANNELS_JS_PATH })
  context.renderRepoTabs()

  const repoTabs = elements.get("repo-tabs")
  assert.equal(repoTabs.children.length, 3, "expected ALL plus one tab per repo")

  const btrainTab = repoTabs.children[1]
  const cgraphTab = repoTabs.children[2]

  assert.match(btrainTab.innerHTML, /Claude 4 · Codex/, btrainTab.innerHTML || "expected btrain agents in tab")
  assert.match(cgraphTab.innerHTML, /Claude 3/, cgraphTab.innerHTML || "expected cgraph agent in tab")
  assert.match(btrainTab.innerHTML, /2A · 2G/, btrainTab.innerHTML || "expected btrain counts in tab")
})

test("multi-repo lane tabs render grouped repo boxes", async () => {
  const source = await fs.readFile(CHANNELS_JS_PATH, "utf8")
  const { context, elements } = buildChannelsHarness()

  vm.runInContext(source, context, { filename: CHANNELS_JS_PATH })
  context.renderChannelTabs()

  const laneTabs = elements.get("lane-tabs")
  assert.match(laneTabs.className, /lane-tabs-grouped/, laneTabs.className || "expected grouped lane tabs class")
  assert.equal(laneTabs.children.length, 2, "expected one repo group per repo")

  const firstGroup = laneTabs.children[0]
  const secondGroup = laneTabs.children[1]
  assert.equal(firstGroup.dataset.repo, "btrain")
  assert.equal(secondGroup.dataset.repo, "cgraph")
  assert.equal(firstGroup.children[1].children.length, 2, "expected btrain group to contain its lane pills")
  assert.equal(secondGroup.children[1].children.length, 2, "expected cgraph group to contain its lane pills")
  assert.ok(firstGroup.style.getPropertyValue("--repo-accent"), "expected repo accent to be applied to group")
})

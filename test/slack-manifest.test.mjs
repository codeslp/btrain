// Spec 024 FR-14 (part of T026) and spec 025 FR-12 (plan WS2 step 6): the two
// Slack app manifests btrain ships. A developer creates the app from one of
// them; the scopes are the whole of what the token can do.
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const DOCS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "docs")
const read = (name) => JSON.parse(fs.readFileSync(path.join(DOCS, name), "utf8"))

const PUBLISHER_SCOPES = ["chat:write", "pins:write"]
const READ_SCOPES = ["channels:history", "groups:history"]

describe("Slack app manifests", () => {
  const publisher = read("slack-app-manifest.json")
  const listen = read("slack-app-manifest-listen.json")

  it("gives the publisher a bot user and exactly its two scopes (spec 024 FR-14)", () => {
    assert.deepEqual([...publisher.oauth_config.scopes.bot].sort(), PUBLISHER_SCOPES)
    assert.equal(publisher.oauth_config.scopes.user, undefined, "no user token scopes")
    assert.equal(typeof publisher.features.bot_user.display_name, "string")
    assert.ok(!publisher.oauth_config.scopes.bot.includes("chat:write.public"), "chat:write.public is not needed")
  })

  it("gives the listener exactly the publisher's scopes plus the two read scopes (spec 025 FR-12)", () => {
    assert.deepEqual([...listen.oauth_config.scopes.bot].sort(), [...PUBLISHER_SCOPES, ...READ_SCOPES].sort())
    assert.equal(listen.oauth_config.scopes.user, undefined)
  })

  it("uses no events, interactivity, slash commands, or socket mode: the publisher posts and the listener polls", () => {
    for (const manifest of [publisher, listen]) {
      assert.equal(manifest.settings?.event_subscriptions, undefined)
      assert.equal(manifest.settings?.interactivity, undefined)
      assert.equal(manifest.features?.slash_commands, undefined)
      assert.equal(manifest.settings.socket_mode_enabled, false)
      assert.equal(manifest.settings.org_deploy_enabled, false, "an internal app of one workspace")
    }
  })

  it("differs between the two only in the scopes and the name", () => {
    const strip = (manifest) => {
      const copy = structuredClone(manifest)
      delete copy.oauth_config.scopes.bot
      delete copy.display_information
      return copy
    }
    assert.deepEqual(strip(listen), strip(publisher))
  })
})

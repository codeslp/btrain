import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  DEFAULT_HARNESS_PROFILE_ID,
  FALLBACK_LOOP_DISPATCH_PROMPT,
  getConfiguredHarnessProfileId,
  inspectHarnessProfile,
  listHarnessProfiles,
  loadHarnessProfile,
  loadHarnessRegistry,
  normalizeHarnessProfileId,
} from "../src/brain_train/harness/index.mjs"

async function makeTmpRepo() {
  return fs.mkdtemp(path.join(os.tmpdir(), "btrain-harness-test-"))
}

async function rmDir(dirPath) {
  await fs.rm(dirPath, { recursive: true, force: true })
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), "utf8")
}

async function writeRaw(filePath, raw) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, raw, "utf8")
}

describe("normalizeHarnessProfileId", () => {
  it("returns null for non-string or empty input", () => {
    assert.equal(normalizeHarnessProfileId(undefined), null)
    assert.equal(normalizeHarnessProfileId(""), null)
    assert.equal(normalizeHarnessProfileId("   "), null)
    assert.equal(normalizeHarnessProfileId(42), null)
  })

  it("lowercases and slug-normalizes valid ids", () => {
    assert.equal(normalizeHarnessProfileId("Default"), "default")
    assert.equal(normalizeHarnessProfileId("My Profile"), "my-profile")
    assert.equal(normalizeHarnessProfileId("  weird__name!! "), "weird__name")
    assert.equal(normalizeHarnessProfileId("---leading-trailing---"), "leading-trailing")
  })
})

describe("getConfiguredHarnessProfileId", () => {
  it("returns the default id when no harness config is present", () => {
    assert.equal(getConfiguredHarnessProfileId({}), DEFAULT_HARNESS_PROFILE_ID)
    assert.equal(getConfiguredHarnessProfileId(null), DEFAULT_HARNESS_PROFILE_ID)
    assert.equal(getConfiguredHarnessProfileId({ harness: null }), DEFAULT_HARNESS_PROFILE_ID)
  })

  it("reads active_profile, activeProfile, and profile aliases", () => {
    assert.equal(getConfiguredHarnessProfileId({ harness: { active_profile: "Alpha" } }), "alpha")
    assert.equal(getConfiguredHarnessProfileId({ harness: { activeProfile: "beta" } }), "beta")
    assert.equal(getConfiguredHarnessProfileId({ harness: { profile: "Gamma_1" } }), "gamma_1")
  })

  it("falls back to default when the configured id is invalid", () => {
    assert.equal(getConfiguredHarnessProfileId({ harness: { profile: "   " } }), DEFAULT_HARNESS_PROFILE_ID)
  })
})

describe("loadHarnessRegistry", () => {
  it("returns the bundled registry when no repoRoot is provided", async () => {
    const registry = await loadHarnessRegistry({})
    assert.equal(registry.version, "1")
    assert.ok(registry.registryPaths.bundled.endsWith("registry.json"))
    assert.equal(registry.registryPaths.repoLocal, "")
    const defaultEntry = registry.profiles.find((entry) => entry.id === "default")
    assert.ok(defaultEntry, "bundled default profile should be present")
    assert.equal(defaultEntry.source, "bundled")
  })

  it("merges a repo-local registry with the bundled registry and prefers repo entries", async () => {
    const repoRoot = await makeTmpRepo()
    try {
      await writeJson(path.join(repoRoot, ".btrain/harness/registry.json"), {
        version: 2,
        label: "Repo-local harness registry",
        description: "Repo override",
        authoringDocs: ["docs/harness-authoring.md"],
        profiles: [
          {
            id: "default",
            path: "profiles/default.json",
            source: "repo-local",
          },
          {
            id: "custom",
            path: "profiles/custom.json",
          },
        ],
      })
      await writeJson(path.join(repoRoot, ".btrain/harness/profiles/default.json"), {
        id: "default",
        label: "Repo default",
        loop: { dispatchPrompt: "repo-bth" },
      })
      await writeJson(path.join(repoRoot, ".btrain/harness/profiles/custom.json"), {
        id: "custom",
        label: "Custom",
        loop: { dispatchPrompt: "custom-bth" },
      })

      const registry = await loadHarnessRegistry({ repoRoot })
      assert.equal(registry.version, "2")
      assert.equal(registry.label, "Repo-local harness registry")
      assert.ok(registry.registryPaths.repoLocal.endsWith(".btrain/harness/registry.json"))
      assert.ok(registry.authoringDocs.includes("docs/harness-authoring.md"))

      const byId = Object.fromEntries(registry.profiles.map((entry) => [entry.id, entry]))
      assert.ok(byId.default, "default profile should exist after merge")
      assert.equal(byId.default.source, "repo-local", "repo-local entry should override bundled")
      assert.ok(byId.default.registered)
      assert.ok(byId.custom, "custom profile should be loaded from repo registry")
      assert.equal(byId.custom.source, "repo-local")
    } finally {
      await rmDir(repoRoot)
    }
  })

  it("discovers repo-local profile files without a registry.json", async () => {
    const repoRoot = await makeTmpRepo()
    try {
      await writeJson(path.join(repoRoot, ".btrain/harness/profiles/extra.json"), {
        id: "extra",
        label: "Extra",
        loop: { dispatchPrompt: "extra-bth" },
      })

      const registry = await loadHarnessRegistry({ repoRoot })
      assert.equal(registry.registryPaths.repoLocal, "", "no repo registry file should be reported")
      const extra = registry.profiles.find((entry) => entry.id === "extra")
      assert.ok(extra, "discovered repo-local profile should be present")
      assert.equal(extra.source, "repo-local")
      assert.equal(extra.registered, false, "convention-discovered profiles are not registered")
    } finally {
      await rmDir(repoRoot)
    }
  })

  it("throws a structured BtrainError on malformed repo-local registry.json", async () => {
    const repoRoot = await makeTmpRepo()
    try {
      await writeRaw(path.join(repoRoot, ".btrain/harness/registry.json"), "{ not valid json")

      await assert.rejects(
        () => loadHarnessRegistry({ repoRoot }),
        (error) => {
          assert.equal(error.name, "BtrainError")
          assert.match(error.message, /Malformed harness registry JSON/)
          assert.match(error.message, /\.btrain\/harness\/registry\.json/)
          assert.match(error.message, /Why:/)
          assert.match(error.message, /Fix:/)
          return true
        },
      )
    } finally {
      await rmDir(repoRoot)
    }
  })
})

describe("listHarnessProfiles", () => {
  it("marks the configured active profile and surfaces bundled defaults", async () => {
    const result = await listHarnessProfiles({ activeProfileId: "default" })
    assert.equal(result.activeProfileId, "default")
    const defaultProfile = result.profiles.find((entry) => entry.id === "default")
    assert.ok(defaultProfile, "bundled default profile should be listed")
    assert.equal(defaultProfile.active, true)
    assert.equal(defaultProfile.exists, true)
    assert.equal(defaultProfile.loop.dispatchPrompt, "bth")
  })

  it("falls back to the default active id when none is supplied", async () => {
    const result = await listHarnessProfiles({})
    assert.equal(result.activeProfileId, DEFAULT_HARNESS_PROFILE_ID)
  })

  it("reports repo-local overrides as active and surfaces the override dispatch prompt", async () => {
    const repoRoot = await makeTmpRepo()
    try {
      await writeJson(path.join(repoRoot, ".btrain/harness/registry.json"), {
        version: 1,
        profiles: [{ id: "default", path: "profiles/default.json", source: "repo-local" }],
      })
      await writeJson(path.join(repoRoot, ".btrain/harness/profiles/default.json"), {
        id: "default",
        label: "Repo default",
        loop: { dispatchPrompt: "repo-bth" },
      })

      const result = await listHarnessProfiles({ repoRoot, activeProfileId: "default" })
      const defaultProfile = result.profiles.find((entry) => entry.id === "default")
      assert.ok(defaultProfile)
      assert.equal(defaultProfile.active, true)
      assert.equal(defaultProfile.source, "repo-local")
      assert.equal(defaultProfile.loop.dispatchPrompt, "repo-bth")
    } finally {
      await rmDir(repoRoot)
    }
  })
})

describe("inspectHarnessProfile", () => {
  it("returns the active profile details by default", async () => {
    const result = await inspectHarnessProfile({ activeProfileId: "default" })
    assert.ok(result, "active profile should be resolved")
    assert.equal(result.profile.id, "default")
    assert.equal(result.profile.active, true)
    assert.equal(result.profile.loop.dispatchPrompt, "bth")
  })

  it("returns null for an unknown profile id", async () => {
    const result = await inspectHarnessProfile({ profileId: "nonexistent" })
    assert.equal(result, null)
  })

  it("propagates a structured BtrainError when the selected profile JSON is malformed", async () => {
    const repoRoot = await makeTmpRepo()
    try {
      await writeJson(path.join(repoRoot, ".btrain/harness/registry.json"), {
        version: 1,
        profiles: [{ id: "broken", path: "profiles/broken.json", source: "repo-local" }],
      })
      await writeRaw(path.join(repoRoot, ".btrain/harness/profiles/broken.json"), "{ nope")

      await assert.rejects(
        () => inspectHarnessProfile({ repoRoot, profileId: "broken" }),
        (error) => {
          assert.equal(error.name, "BtrainError")
          assert.match(error.message, /Malformed harness profile JSON/)
          assert.match(error.message, /broken\.json/)
          return true
        },
      )
    } finally {
      await rmDir(repoRoot)
    }
  })
})

describe("loadHarnessProfile", () => {
  it("loads the bundled default profile with the fallback dispatch prompt", async () => {
    const profile = await loadHarnessProfile({ profileId: "default" })
    assert.ok(profile)
    assert.equal(profile.id, "default")
    assert.equal(profile.loop.dispatchPrompt, "bth")
    assert.ok(profile.sourcePath.endsWith("default.json"))
  })

  it("returns null for an unknown profile id", async () => {
    const profile = await loadHarnessProfile({ profileId: "missing-profile" })
    assert.equal(profile, null)
  })

  it("prefers the repo-local profile over the bundled one", async () => {
    const repoRoot = await makeTmpRepo()
    try {
      await writeJson(path.join(repoRoot, ".btrain/harness/profiles/default.json"), {
        id: "default",
        label: "Repo default",
        loop: { dispatchPrompt: "repo-bth" },
      })

      const profile = await loadHarnessProfile({ repoRoot, profileId: "default" })
      assert.ok(profile)
      assert.equal(profile.label, "Repo default")
      assert.equal(profile.loop.dispatchPrompt, "repo-bth")
      assert.ok(profile.sourcePath.startsWith(repoRoot))
    } finally {
      await rmDir(repoRoot)
    }
  })

  it("uses the fallback dispatch prompt constant when the profile omits it", async () => {
    const repoRoot = await makeTmpRepo()
    try {
      await writeJson(path.join(repoRoot, ".btrain/harness/profiles/bare.json"), {
        id: "bare",
      })

      const profile = await loadHarnessProfile({ repoRoot, profileId: "bare" })
      assert.ok(profile)
      assert.equal(profile.loop.dispatchPrompt, FALLBACK_LOOP_DISPATCH_PROMPT)
    } finally {
      await rmDir(repoRoot)
    }
  })
})

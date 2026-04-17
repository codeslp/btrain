import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const HARNESS_DIR = path.dirname(fileURLToPath(import.meta.url))
const BUNDLED_PROFILES_DIR = path.join(HARNESS_DIR, "profiles")

export const DEFAULT_HARNESS_PROFILE_ID = "default"
export const FALLBACK_LOOP_DISPATCH_PROMPT = "bth"

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath)
    return true
  } catch {
    return false
  }
}

export function normalizeHarnessProfileId(value) {
  if (typeof value !== "string") {
    return null
  }

  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")

  return normalized || null
}

function normalizeHarnessProfile(rawProfile = {}, { fallbackId, sourcePath } = {}) {
  const profile = rawProfile && typeof rawProfile === "object" && !Array.isArray(rawProfile) ? rawProfile : {}
  const loop = profile.loop && typeof profile.loop === "object" && !Array.isArray(profile.loop) ? profile.loop : {}

  return {
    id: normalizeHarnessProfileId(profile.id) || fallbackId || DEFAULT_HARNESS_PROFILE_ID,
    label: typeof profile.label === "string" ? profile.label.trim() : "",
    description: typeof profile.description === "string" ? profile.description.trim() : "",
    loop: {
      dispatchPrompt:
        typeof loop.dispatchPrompt === "string" && loop.dispatchPrompt.trim()
          ? loop.dispatchPrompt.trim()
          : FALLBACK_LOOP_DISPATCH_PROMPT,
    },
    sourcePath: sourcePath || "",
  }
}

async function readHarnessProfile(profilePath, fallbackId) {
  const raw = await fs.readFile(profilePath, "utf8")
  const parsed = JSON.parse(raw)
  return normalizeHarnessProfile(parsed, { fallbackId, sourcePath: profilePath })
}

function getRepoHarnessProfilePath(repoRoot, profileId) {
  return path.join(repoRoot, ".btrain", "harness", "profiles", `${profileId}.json`)
}

function getBundledHarnessProfilePath(profileId) {
  return path.join(BUNDLED_PROFILES_DIR, `${profileId}.json`)
}

export async function loadHarnessProfile({ repoRoot = "", profileId } = {}) {
  const normalizedId = normalizeHarnessProfileId(profileId) || DEFAULT_HARNESS_PROFILE_ID
  if (repoRoot) {
    const repoProfilePath = getRepoHarnessProfilePath(repoRoot, normalizedId)
    if (await pathExists(repoProfilePath)) {
      return readHarnessProfile(repoProfilePath, normalizedId)
    }
  }

  const bundledProfilePath = getBundledHarnessProfilePath(normalizedId)
  if (await pathExists(bundledProfilePath)) {
    return readHarnessProfile(bundledProfilePath, normalizedId)
  }

  return null
}

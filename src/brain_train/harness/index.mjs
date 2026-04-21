import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const HARNESS_DIR = path.dirname(fileURLToPath(import.meta.url))
const BUNDLED_PROFILES_DIR = path.join(HARNESS_DIR, "profiles")
const BUNDLED_REGISTRY_PATH = path.join(HARNESS_DIR, "registry.json")

export const DEFAULT_HARNESS_PROFILE_ID = "default"
export const FALLBACK_LOOP_DISPATCH_PROMPT = "bth"
export const DEFAULT_HARNESS_REGISTRY_COMMANDS = [
  "btrain harness list",
  "btrain harness inspect --profile <name>",
]
export const DEFAULT_HARNESS_REGISTRY_SCHEMAS = {
  registry: "brain-train/harness-registry@v1",
  profile: "brain-train/harness-profile@v1",
}

class BtrainError extends Error {
  constructor({ message, reason, fix, context }) {
    const parts = [`✖ ${message}`]
    if (reason)  parts.push(`  ↳ Why: ${reason}`)
    if (fix)     parts.push(`  ✦ Fix: ${fix}`)
    if (context) parts.push(`  ℹ ${context}`)
    super(parts.join("\n"))
    this.name = "BtrainError"
  }
}

async function parseJsonFile(filePath, { kind } = {}) {
  const raw = await fs.readFile(filePath, "utf8")
  try {
    return JSON.parse(raw)
  } catch (error) {
    const label = kind === "registry" ? "harness registry" : "harness profile"
    throw new BtrainError({
      message: `Malformed ${label} JSON at ${filePath}.`,
      reason: error?.message || "JSON.parse failed.",
      fix: `Repair the JSON syntax in ${filePath} (e.g. validate with \`node -e \"JSON.parse(require('node:fs').readFileSync('${filePath}','utf8'))\"\`).`,
    })
  }
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath)
    return true
  } catch {
    return false
  }
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : ""
}

function normalizeStringList(value) {
  const source = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value]
  return [...new Set(source.map((item) => normalizeText(item)).filter(Boolean))]
}

function normalizeStringMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {}
  }

  return Object.fromEntries(
    Object.entries(value)
      .map(([key, entryValue]) => [normalizeText(key), normalizeText(entryValue)])
      .filter(([key, entryValue]) => key && entryValue),
  )
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

export function getConfiguredHarnessProfileId(config) {
  const harness = config?.harness && typeof config.harness === "object" ? config.harness : {}
  return (
    normalizeHarnessProfileId(harness.active_profile || harness.activeProfile || harness.profile)
    || DEFAULT_HARNESS_PROFILE_ID
  )
}

function normalizeHarnessProfile(rawProfile = {}, { fallbackId, sourcePath } = {}) {
  const profile = rawProfile && typeof rawProfile === "object" && !Array.isArray(rawProfile) ? rawProfile : {}
  const loop = profile.loop && typeof profile.loop === "object" && !Array.isArray(profile.loop) ? profile.loop : {}

  return {
    id: normalizeHarnessProfileId(profile.id) || fallbackId || DEFAULT_HARNESS_PROFILE_ID,
    label: typeof profile.label === "string" ? profile.label.trim() : "",
    description: typeof profile.description === "string" ? profile.description.trim() : "",
    purpose: normalizeText(profile.purpose),
    surfaces: normalizeStringList(profile.surfaces),
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
  const parsed = await parseJsonFile(profilePath, { kind: "profile" })
  return normalizeHarnessProfile(parsed, { fallbackId, sourcePath: profilePath })
}

function getRepoHarnessDir(repoRoot) {
  return path.join(repoRoot, ".btrain", "harness")
}

function getRepoHarnessProfilesDir(repoRoot) {
  return path.join(getRepoHarnessDir(repoRoot), "profiles")
}

function getRepoHarnessRegistryPath(repoRoot) {
  return path.join(getRepoHarnessDir(repoRoot), "registry.json")
}

function getRepoHarnessProfilePath(repoRoot, profileId) {
  return path.join(getRepoHarnessProfilesDir(repoRoot), `${profileId}.json`)
}

function getBundledHarnessProfilePath(profileId) {
  return path.join(BUNDLED_PROFILES_DIR, `${profileId}.json`)
}

function resolveRegistryProfileEntries(rawProfiles) {
  if (Array.isArray(rawProfiles)) {
    return rawProfiles
  }

  if (!rawProfiles || typeof rawProfiles !== "object") {
    return []
  }

  return Object.entries(rawProfiles).map(([id, value]) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return { id, ...value }
    }

    return { id, path: value }
  })
}

function normalizeRegistryProfileEntry(rawEntry, { registryPath, source, fallbackProfilesDir } = {}) {
  const entry = rawEntry && typeof rawEntry === "object" && !Array.isArray(rawEntry) ? rawEntry : { path: rawEntry }
  const id = normalizeHarnessProfileId(entry.id || entry.profileId || entry.profile || entry.name)
  if (!id) {
    return null
  }

  const relativePath = normalizeText(entry.path || entry.profilePath || entry.file)
  const profilePath = relativePath
    ? path.isAbsolute(relativePath)
      ? relativePath
      : path.resolve(path.dirname(registryPath), relativePath)
    : path.join(fallbackProfilesDir, `${id}.json`)

  return {
    id,
    source: normalizeText(entry.source) || source || "",
    profilePath,
    registryPath: registryPath || "",
    registered: true,
  }
}

function normalizeRegistry(rawRegistry = {}, { registryPath, source, fallbackProfilesDir } = {}) {
  const registry = rawRegistry && typeof rawRegistry === "object" && !Array.isArray(rawRegistry) ? rawRegistry : {}
  const version =
    typeof registry.version === "number" ? String(registry.version) : normalizeText(registry.version) || "1"

  return {
    version,
    label: normalizeText(registry.label),
    description: normalizeText(registry.description),
    commands: normalizeStringList([...DEFAULT_HARNESS_REGISTRY_COMMANDS, ...(registry.commands || [])]),
    schemas: {
      ...DEFAULT_HARNESS_REGISTRY_SCHEMAS,
      ...normalizeStringMap(registry.schemas),
    },
    authoringDocs: normalizeStringList(registry.authoringDocs || registry.authoring?.docs),
    profiles: resolveRegistryProfileEntries(registry.profiles)
      .map((entry) => normalizeRegistryProfileEntry(entry, { registryPath, source, fallbackProfilesDir }))
      .filter(Boolean),
    registryPath: registryPath || "",
    source: source || "",
  }
}

async function readRegistryFile(registryPath, { source, fallbackProfilesDir } = {}) {
  const parsed = await parseJsonFile(registryPath, { kind: "registry" })
  return normalizeRegistry(parsed, { registryPath, source, fallbackProfilesDir })
}

function mergeProfileEntries(...groups) {
  const merged = new Map()

  for (const group of groups) {
    for (const entry of group || []) {
      if (!entry?.id) {
        continue
      }

      merged.set(entry.id, {
        ...merged.get(entry.id),
        ...entry,
        id: entry.id,
      })
    }
  }

  return [...merged.values()].sort((left, right) => left.id.localeCompare(right.id))
}

async function discoverProfilesInDir(profilesDir, source) {
  if (!(await pathExists(profilesDir))) {
    return []
  }

  const entries = await fs.readdir(profilesDir, { withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => {
      const id = normalizeHarnessProfileId(path.basename(entry.name, ".json"))
      if (!id) {
        return null
      }

      return {
        id,
        source,
        profilePath: path.join(profilesDir, entry.name),
        registryPath: "",
        registered: false,
      }
    })
    .filter(Boolean)
    .sort((left, right) => left.id.localeCompare(right.id))
}

async function resolveHarnessProfileEntry({ repoRoot = "", profileId, registry } = {}) {
  const normalizedId = normalizeHarnessProfileId(profileId)
  if (!normalizedId) {
    return null
  }

  const resolvedRegistry = registry || (await loadHarnessRegistry({ repoRoot }))
  const fromRegistry = resolvedRegistry.profiles.find((entry) => entry.id === normalizedId)
  if (fromRegistry) {
    return fromRegistry
  }

  const candidates = []
  if (repoRoot) {
    candidates.push({
      id: normalizedId,
      source: "repo-local",
      profilePath: getRepoHarnessProfilePath(repoRoot, normalizedId),
      registryPath: "",
      registered: false,
    })
  }
  candidates.push({
    id: normalizedId,
    source: "bundled",
    profilePath: getBundledHarnessProfilePath(normalizedId),
    registryPath: "",
    registered: false,
  })

  for (const candidate of candidates) {
    if (await pathExists(candidate.profilePath)) {
      return candidate
    }
  }

  return null
}

async function summarizeHarnessProfileEntry(entry) {
  try {
    const profile = await readHarnessProfile(entry.profilePath, entry.id)
    return {
      ...entry,
      ...profile,
      exists: true,
      error: "",
    }
  } catch (error) {
    return {
      ...entry,
      label: "",
      description: "",
      purpose: "",
      surfaces: [],
      loop: {
        dispatchPrompt: FALLBACK_LOOP_DISPATCH_PROMPT,
      },
      exists: await pathExists(entry.profilePath),
      error: error?.message || "Failed to read harness profile.",
    }
  }
}

export async function loadHarnessRegistry({ repoRoot = "" } = {}) {
  const bundledRegistry = (await pathExists(BUNDLED_REGISTRY_PATH))
    ? await readRegistryFile(BUNDLED_REGISTRY_PATH, {
        source: "bundled",
        fallbackProfilesDir: BUNDLED_PROFILES_DIR,
      })
    : normalizeRegistry({}, {
        registryPath: BUNDLED_REGISTRY_PATH,
        source: "bundled",
        fallbackProfilesDir: BUNDLED_PROFILES_DIR,
      })

  const repoRegistryPath = repoRoot ? getRepoHarnessRegistryPath(repoRoot) : ""
  const repoRegistryExists = repoRegistryPath ? await pathExists(repoRegistryPath) : false
  const repoRegistry =
    repoRegistryExists
      ? await readRegistryFile(repoRegistryPath, {
          source: "repo-local",
          fallbackProfilesDir: getRepoHarnessProfilesDir(repoRoot),
        })
      : null

  const bundledDiscoveredProfiles = await discoverProfilesInDir(BUNDLED_PROFILES_DIR, "bundled")
  const repoDiscoveredProfiles = repoRoot
    ? await discoverProfilesInDir(getRepoHarnessProfilesDir(repoRoot), "repo-local")
    : []

  return {
    version: repoRegistry?.version || bundledRegistry.version || "1",
    label: repoRegistry?.label || bundledRegistry.label || "",
    description: repoRegistry?.description || bundledRegistry.description || "",
    commands: normalizeStringList([
      ...(bundledRegistry.commands || []),
      ...(repoRegistry?.commands || []),
    ]),
    schemas: {
      ...bundledRegistry.schemas,
      ...(repoRegistry?.schemas || {}),
    },
    authoringDocs: normalizeStringList([
      ...(bundledRegistry.authoringDocs || []),
      ...(repoRegistry?.authoringDocs || []),
    ]),
    profiles: mergeProfileEntries(
      bundledDiscoveredProfiles,
      bundledRegistry.profiles,
      repoDiscoveredProfiles,
      repoRegistry?.profiles,
    ),
    registryPaths: {
      bundled: BUNDLED_REGISTRY_PATH,
      repoLocal: repoRegistryExists ? repoRegistryPath : "",
    },
  }
}

export async function listHarnessProfiles({ repoRoot = "", activeProfileId } = {}) {
  const registry = await loadHarnessRegistry({ repoRoot })
  const normalizedActiveId = normalizeHarnessProfileId(activeProfileId) || DEFAULT_HARNESS_PROFILE_ID
  const profiles = await Promise.all(
    registry.profiles.map(async (entry) => ({
      ...(await summarizeHarnessProfileEntry(entry)),
      active: entry.id === normalizedActiveId,
    })),
  )

  return {
    ...registry,
    activeProfileId: normalizedActiveId,
    profiles,
  }
}

export async function inspectHarnessProfile({ repoRoot = "", profileId, activeProfileId } = {}) {
  const registry = await loadHarnessRegistry({ repoRoot })
  const normalizedActiveId = normalizeHarnessProfileId(activeProfileId) || DEFAULT_HARNESS_PROFILE_ID
  const normalizedRequestedId = normalizeHarnessProfileId(profileId) || normalizedActiveId
  const entry = await resolveHarnessProfileEntry({
    repoRoot,
    profileId: normalizedRequestedId,
    registry,
  })

  if (!entry) {
    return null
  }

  const profile = await readHarnessProfile(entry.profilePath, normalizedRequestedId)
  return {
    ...registry,
    activeProfileId: normalizedActiveId,
    profile: {
      ...entry,
      ...profile,
      active: normalizedRequestedId === normalizedActiveId,
    },
  }
}

export async function loadHarnessProfile({ repoRoot = "", profileId } = {}) {
  const normalizedId = normalizeHarnessProfileId(profileId) || DEFAULT_HARNESS_PROFILE_ID
  const entry = await resolveHarnessProfileEntry({ repoRoot, profileId: normalizedId })
  if (!entry) {
    return null
  }

  return readHarnessProfile(entry.profilePath, normalizedId)
}

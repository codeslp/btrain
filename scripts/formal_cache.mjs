import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"

function digest(value) {
  return crypto.createHash("sha256").update(value).digest("hex")
}

// Hash the entire module directory, including Java overrides and local imports.
// Documentation and old verdicts cannot affect TLC execution. External module
// paths and JVM injection disable reuse rather than creating incomplete keys.
export function tlcIdentity(root, model, config, jar, javaVersion, args) {
  for (const name of ["TLA_LIBRARY", "CLASSPATH", "JAVA_TOOL_OPTIONS", "_JAVA_OPTIONS", "JDK_JAVA_OPTIONS"]) {
    if (process.env[name]) throw new Error(`${name} prevents hermetic TLC cache reuse.`)
  }
  const files = new Set(["scripts/formal_advisory.mjs", "scripts/formal_cache.mjs", "scripts/formal_contracts.json", config])
  function collect(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name)
      if (entry.isSymbolicLink()) throw new Error(`TLC cache does not follow symlinks: ${full}`)
      if (entry.isDirectory()) collect(full)
      else if (/\.(tla|cfg|class|jar)$/i.test(entry.name)) files.add(path.relative(root, full))
    }
  }
  collect(path.dirname(path.join(root, model)))
  const inputs = [...files].sort().map(file => [file, digest(fs.readFileSync(path.join(root, file)))])
  const identity = { schemaVersion: 1, model, inputs, tool: digest(fs.readFileSync(jar)), javaVersion, args }
  return { key: digest(JSON.stringify(identity)), identity }
}

export function readTlcCache(directory, identity) {
  try {
    const file = path.join(directory, `${identity.key}.json`)
    if (fs.lstatSync(file).isSymbolicLink()) return null
    const record = JSON.parse(fs.readFileSync(file, "utf8"))
    if (record.schemaVersion !== 1 || record.key !== identity.key
      || JSON.stringify(record.identity) !== JSON.stringify(identity.identity)
      || record.checkDigest !== digest(JSON.stringify(record.check))
      || record.check?.verdict !== "pass" || record.check.status !== 0
      || record.check.signal || record.check.errorCode
      || !Number.isFinite(record.check.durationMs) || record.check.durationMs < 0
      || !/^[0-9a-f]{40,64}$/.test(record.sourceHead || "")) return null
    return record
  } catch {
    return null
  }
}

export function writeTlcCache(directory, identity, check, sourceHead) {
  if (check.verdict !== "pass" || check.status !== 0 || check.signal || check.errorCode) return
  fs.mkdirSync(directory, { recursive: true })
  const file = path.join(directory, `${identity.key}.json`)
  const temporary = `${file}.${crypto.randomUUID()}.tmp`
  try {
    fs.writeFileSync(temporary, JSON.stringify({
      schemaVersion: 1, ...identity, sourceHead, createdAt: new Date().toISOString(),
      check, checkDigest: digest(JSON.stringify(check)),
    }))
    fs.renameSync(temporary, file)
  } finally {
    fs.rmSync(temporary, { force: true })
  }
}

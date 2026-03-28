import { spawnSync, type SpawnSyncOptionsWithBufferEncoding, type SpawnSyncReturns } from "node:child_process"
import { createHash } from "node:crypto"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join, relative, resolve, sep } from "node:path"

const ARCHIVE_MAGIC = Buffer.from("SENDRT1\0", "utf8")
const READY_FILE = ".send-standalone-ready.json"
const encoder = new TextEncoder()
const decoder = new TextDecoder()
const ROOT_FILES = new Set(["LICENSE", "README.md", "package.json", "tsconfig.json"])

export type RuntimeArchiveFile = {
  absolutePath: string
  relativePath: string
  size: number
}

export type RuntimeArchiveInfo = {
  archivePath: string
  fileCount: number
  hash: string
  totalBytes: number
}

export type EnsureExtractedRuntimeOptions = {
  archivePath: string
  packageName: string
  packageVersion: string
  runtimeHash: string
}

export type RunExtractedRuntimeOptions = {
  args?: readonly string[]
  entrypointRelativePath: string
  env?: NodeJS.ProcessEnv
  execPath?: string
  runtimeRoot: string
  stdio?: SpawnSyncOptionsWithBufferEncoding["stdio"]
}

export type LaunchStandaloneRuntimeOptions = EnsureExtractedRuntimeOptions & {
  args?: readonly string[]
  entrypointRelativePath: string
}

const normalizeRelativePath = (path: string) => path.replaceAll("\\", "/").replace(/^\.\//, "")

const writeUInt32 = (value: number) => {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) throw new Error(`Expected an unsigned 32-bit integer, got ${value}`)
  const buffer = Buffer.allocUnsafe(4)
  buffer.writeUInt32LE(value, 0)
  return buffer
}

const readUInt32 = (bytes: Uint8Array, offset: number) => {
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 4)
  return view.getUint32(0, true)
}

const safePackageDir = (packageName: string) => packageName.replace(/^@/, "").replace(/[\\/]+/g, "-")

const resolveExtractTarget = (outputRoot: string, relativePath: string) => {
  const target = resolve(outputRoot, relativePath)
  const normalizedRoot = resolve(outputRoot)
  const rootPrefix = normalizedRoot.endsWith(sep) ? normalizedRoot : `${normalizedRoot}${sep}`
  if (target !== normalizedRoot && !target.startsWith(rootPrefix)) throw new Error(`Refusing to extract outside runtime root: ${relativePath}`)
  return target
}

export const shouldIncludeRuntimePath = (relativePath: string) => {
  const normalized = normalizeRelativePath(relativePath)
  if (!normalized || normalized === "." || normalized.startsWith("../") || normalized.includes("/../")) return false
  if (normalized === "bun.lock" || normalized === "bun.lockb") return false
  if (normalized.startsWith("node_modules/.bin/")) return false
  if (ROOT_FILES.has(normalized)) return true
  return normalized.startsWith("node_modules/") || normalized.startsWith("runtime/") || normalized.startsWith("src/")
}

export const collectRuntimeFiles = (root: string): RuntimeArchiveFile[] => {
  const files: RuntimeArchiveFile[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absolutePath = join(dir, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        walk(absolutePath)
        continue
      }
      if (!entry.isFile()) continue
      const relativePath = normalizeRelativePath(relative(root, absolutePath))
      if (!shouldIncludeRuntimePath(relativePath)) continue
      files.push({
        absolutePath,
        relativePath,
        size: statSync(absolutePath).size,
      })
    }
  }
  walk(resolve(root))
  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath))
  return files
}

export const buildRuntimeArchive = (root: string, archivePath: string): RuntimeArchiveInfo => {
  const files = collectRuntimeFiles(root)
  const chunks: Buffer[] = [ARCHIVE_MAGIC, writeUInt32(files.length)]
  const hash = createHash("sha256")
  let totalBytes = ARCHIVE_MAGIC.byteLength + 4
  for (const file of files) {
    const pathBytes = Buffer.from(file.relativePath, "utf8")
    const data = readFileSync(file.absolutePath)
    hash.update(pathBytes)
    hash.update("\0")
    hash.update(data)
    chunks.push(writeUInt32(pathBytes.byteLength), pathBytes, writeUInt32(data.byteLength), data)
    totalBytes += 8 + pathBytes.byteLength + data.byteLength
  }
  mkdirSync(dirname(archivePath), { recursive: true })
  writeFileSync(archivePath, Buffer.concat(chunks, totalBytes))
  return {
    archivePath,
    fileCount: files.length,
    hash: hash.digest("hex").slice(0, 12),
    totalBytes,
  }
}

export const extractRuntimeArchive = async (archivePath: string, outputRoot: string) => {
  const bytes = new Uint8Array(await Bun.file(archivePath).arrayBuffer())
  if (bytes.byteLength < ARCHIVE_MAGIC.byteLength + 4) throw new Error(`Standalone runtime archive is too small: ${archivePath}`)
  if (Buffer.compare(Buffer.from(bytes.subarray(0, ARCHIVE_MAGIC.byteLength)), ARCHIVE_MAGIC) !== 0) {
    throw new Error(`Unsupported standalone runtime archive header in ${archivePath}`)
  }
  let offset = ARCHIVE_MAGIC.byteLength
  const fileCount = readUInt32(bytes, offset)
  offset += 4
  for (let index = 0; index < fileCount; index++) {
    if (offset + 8 > bytes.byteLength) throw new Error(`Standalone runtime archive truncated before file ${index + 1}`)
    const pathLength = readUInt32(bytes, offset)
    offset += 4
    if (offset + pathLength > bytes.byteLength) throw new Error(`Standalone runtime archive truncated while reading file ${index + 1} path`)
    const relativePath = decoder.decode(bytes.subarray(offset, offset + pathLength))
    offset += pathLength
    if (!shouldIncludeRuntimePath(relativePath)) throw new Error(`Unexpected runtime archive path: ${relativePath}`)
    const fileSize = readUInt32(bytes, offset)
    offset += 4
    if (offset + fileSize > bytes.byteLength) throw new Error(`Standalone runtime archive truncated while reading ${relativePath}`)
    const target = resolveExtractTarget(outputRoot, relativePath)
    mkdirSync(dirname(target), { recursive: true })
    await Bun.write(target, bytes.subarray(offset, offset + fileSize))
    offset += fileSize
  }
  if (offset !== bytes.byteLength) throw new Error(`Standalone runtime archive has ${bytes.byteLength - offset} trailing bytes`)
  return fileCount
}

export const ensureExtractedRuntime = async (options: EnsureExtractedRuntimeOptions) => {
  const runtimeBase = join(tmpdir(), safePackageDir(options.packageName))
  const runtimeRoot = join(runtimeBase, `${options.packageVersion}-${options.runtimeHash}`)
  const readyPath = join(runtimeRoot, READY_FILE)
  if (existsSync(readyPath)) return runtimeRoot
  mkdirSync(runtimeBase, { recursive: true })
  if (existsSync(runtimeRoot)) rmSync(runtimeRoot, { recursive: true, force: true })
  const tempRoot = mkdtempSync(join(runtimeBase, `${basename(runtimeRoot)}.tmp-`))
  try {
    const fileCount = await extractRuntimeArchive(options.archivePath, tempRoot)
    writeFileSync(
      join(tempRoot, READY_FILE),
      JSON.stringify(
        {
          files: fileCount,
          packageName: options.packageName,
          runtimeHash: options.runtimeHash,
          version: options.packageVersion,
        },
        null,
        2,
      ),
    )
    try {
      renameSync(tempRoot, runtimeRoot)
    } catch (error) {
      if (existsSync(readyPath)) {
        rmSync(tempRoot, { recursive: true, force: true })
        return runtimeRoot
      }
      throw error
    }
  } catch (error) {
    rmSync(tempRoot, { recursive: true, force: true })
    throw error
  }
  return runtimeRoot
}

export const runExtractedRuntime = (options: RunExtractedRuntimeOptions): SpawnSyncReturns<Buffer> => {
  const entrypointPath = join(options.runtimeRoot, options.entrypointRelativePath)
  return spawnSync(options.execPath ?? process.execPath, ["run", entrypointPath, ...(options.args ?? process.argv.slice(2))], {
    cwd: process.cwd(),
    env: { ...(options.env ?? process.env), BUN_BE_BUN: "1" },
    stdio: options.stdio ?? "inherit",
  })
}

export const launchStandaloneRuntime = async (options: LaunchStandaloneRuntimeOptions) => {
  const runtimeRoot = await ensureExtractedRuntime(options)
  const result = runExtractedRuntime({
    args: options.args,
    entrypointRelativePath: options.entrypointRelativePath,
    runtimeRoot,
  })
  if (result.error) throw result.error
  if (result.signal) process.kill(process.pid, result.signal)
  return result.status ?? 1
}

export const renderStandaloneBootstrapSource = (options: {
  archiveImportPath: string
  entrypointRelativePath: string
  helperImportPath: string
  packageName: string
  packageVersion: string
  runtimeHash: string
}) => `import runtimeArchive from ${JSON.stringify(options.archiveImportPath)} with { type: "file" }
import { launchStandaloneRuntime } from ${JSON.stringify(options.helperImportPath)}

const exitCode = await launchStandaloneRuntime({
  archivePath: runtimeArchive,
  packageName: ${JSON.stringify(options.packageName)},
  packageVersion: ${JSON.stringify(options.packageVersion)},
  runtimeHash: ${JSON.stringify(options.runtimeHash)},
  entrypointRelativePath: ${JSON.stringify(options.entrypointRelativePath)},
})

process.exit(exitCode)
`

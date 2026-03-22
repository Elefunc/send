import { readFile, readdir, realpath, stat } from "node:fs/promises"
import { join, relative, resolve, sep } from "node:path"
import { expandHomePath, isHomeDirectoryPath } from "../core/paths"
import type { FileSearchMatch } from "./file-search-protocol"

export interface IndexedEntry {
  absolutePath: string
  relativePath: string
  fileName: string
  kind: "file" | "directory"
}

export interface FileSearchScope {
  normalizedInput: string
  workspaceRoot: string
  displayPrefix: string
  query: string
}

export interface MountInfoEntry {
  mountPoint: string
  fsType: string
  source: string
}

export interface MountProbeResult {
  mount: MountInfoEntry
  probeMs: number
  slow: boolean
}

export interface CrawlWorkspaceOptions {
  mountTable?: readonly MountInfoEntry[]
  probeThresholdMs?: number
  probeMount?: (mount: MountInfoEntry) => Promise<number>
}

export class SlowSearchMountError extends Error {
  readonly mountPoint: string
  readonly probeMs: number

  constructor(mountPoint: string, probeMs: number) {
    super(`Preview search disabled for slow mount ${mountPoint} (${Math.round(probeMs)}ms probe).`)
    this.name = "SlowSearchMountError"
    this.mountPoint = mountPoint
    this.probeMs = probeMs
  }
}

const SKIPPED_DIRECTORIES = new Set([".git", "node_modules"])
const BOUNDARY_CHARS = new Set(["/", "_", "-", "."])
export const FILE_SEARCH_SLOW_MOUNT_MS = 250

const trimTrailingCrLf = (value: string) => value.replace(/[\r\n]+$/u, "")
const normalizeSeparators = (value: string) => value.replace(/\\/gu, "/")
const pathChars = (value: string) => Array.from(value)
const lower = (value: string) => value.toLocaleLowerCase("en-US")
const renderedDisplayPrefix = (displayPrefix: string) => displayPrefix === "~" ? "~/" : displayPrefix
const MOUNTINFO_PATH = "/proc/self/mountinfo"

export const normalizeSearchQuery = (value: string) => normalizeSeparators(trimTrailingCrLf(value))
export const normalizeRelativePath = (value: string) => normalizeSeparators(value.split(sep).join("/"))
export const shouldSkipSearchDirectory = (name: string) => SKIPPED_DIRECTORIES.has(name)
export const isCaseSensitiveQuery = (query: string) => /[A-Z]/u.test(query)
export const isSlowMountProbe = (probeMs: number, thresholdMs = FILE_SEARCH_SLOW_MOUNT_MS) => probeMs >= thresholdMs

const isBoundaryIndex = (chars: string[], index: number) => index === 0 || BOUNDARY_CHARS.has(chars[index - 1] || "")
const decodeMountInfoValue = (value: string) => value.replace(/\\([0-7]{3})/gu, (_, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)))
const pathOnMount = (path: string, mountPoint: string) => mountPoint === "/" || path === mountPoint || path.startsWith(`${mountPoint}/`)
const sortMountTable = (mounts: readonly MountInfoEntry[]) => [...mounts].sort((left, right) => right.mountPoint.length - left.mountPoint.length || left.mountPoint.localeCompare(right.mountPoint))

const basenameStartIndex = (chars: string[]) => {
  for (let index = chars.length - 1; index >= 0; index -= 1) if (chars[index] === "/") return index + 1
  return 0
}

export const parseMountInfo = (text: string): MountInfoEntry[] => sortMountTable(text
  .split(/\r?\n/u)
  .map(line => line.trim())
  .filter(Boolean)
  .flatMap(line => {
    const parts = line.split(" - ", 2)
    if (parts.length !== 2) return []
    const left = parts[0]!.split(" ")
    const right = parts[1]!.split(" ")
    if (left.length < 5 || right.length < 2) return []
    return [{
      mountPoint: decodeMountInfoValue(left[4]!),
      fsType: right[0]!,
      source: right[1]!,
    } satisfies MountInfoEntry]
  }))

export const findMountForPath = (mounts: readonly MountInfoEntry[], path: string) => {
  const absolute = resolve(path)
  return sortMountTable(mounts).find(mount => pathOnMount(absolute, mount.mountPoint)) ?? null
}

const loadMountTable = async () => {
  try {
    return parseMountInfo(await readFile(MOUNTINFO_PATH, "utf8"))
  } catch {
    return []
  }
}

const measureMountProbe = async (mount: MountInfoEntry) => {
  const startedAt = performance.now()
  await readdir(mount.mountPoint, { withFileTypes: true })
  return performance.now() - startedAt
}

export const deriveFileSearchScope = (value: string, cwd = process.cwd()): FileSearchScope | null => {
  const normalizedInput = normalizeSearchQuery(value)
  if (!normalizedInput) return null
  if (normalizedInput === "~") {
    return {
      normalizedInput,
      workspaceRoot: expandHomePath(normalizedInput)!,
      displayPrefix: "~",
      query: "",
    }
  }
  const slashIndex = normalizedInput.endsWith("/")
    ? normalizedInput.length - 1
    : normalizedInput.lastIndexOf("/")
  const displayPrefix = slashIndex >= 0 ? normalizedInput.slice(0, slashIndex + 1) : ""
  return {
    normalizedInput,
    workspaceRoot: isHomeDirectoryPath(displayPrefix || ".")
      ? expandHomePath(displayPrefix || ".")!
      : resolve(cwd, displayPrefix || "."),
    displayPrefix,
    query: normalizedInput.slice(displayPrefix.length),
  }
}

export const formatFileSearchDisplayPath = (displayPrefix: string, relativePath: string) =>
  !displayPrefix ? relativePath : renderedDisplayPrefix(displayPrefix) === "/" ? `/${relativePath}` : `${renderedDisplayPrefix(displayPrefix)}${relativePath}`

export const offsetFileSearchMatchIndices = (displayPrefix: string, indices: number[]) => {
  const offset = pathChars(renderedDisplayPrefix(displayPrefix)).length
  return offset ? indices.map(index => index + offset) : indices
}

export const matchPathQuery = (relativePath: string, query: string) => {
  const normalizedQuery = normalizeSearchQuery(query)
  if (!normalizedQuery) return null
  const chars = pathChars(relativePath)
  const queryChars = pathChars(normalizedQuery)
  const caseSensitive = isCaseSensitiveQuery(normalizedQuery)
  const haystack = caseSensitive ? chars : chars.map(lower)
  const needle = caseSensitive ? queryChars : queryChars.map(lower)
  const indices: number[] = []
  let cursor = 0
  for (const token of needle) {
    let found = -1
    for (let index = cursor; index < haystack.length; index += 1) {
      if (haystack[index] === token) {
        found = index
        break
      }
    }
    if (found < 0) return null
    indices.push(found)
    cursor = found + 1
  }
  const basenameStart = basenameStartIndex(chars)
  const contiguousBasenamePrefix = indices[0] === basenameStart && indices.every((value, index) => value === basenameStart + index)
  let score = indices.length
  if (indices[0] === basenameStart) score += 80
  if (contiguousBasenamePrefix) score += 120
  for (let index = 0; index < indices.length; index += 1) {
    if (isBoundaryIndex(chars, indices[index]!)) score += 12
    if (index > 0 && indices[index] === indices[index - 1]! + 1) score += 8
  }
  score -= Math.floor(chars.length / 16)
  return { indices, score }
}

const browseEntries = (entries: readonly IndexedEntry[], resultLimit: number) => entries
  .filter(entry => !entry.relativePath.includes("/"))
  .sort((left, right) => (left.kind === right.kind ? 0 : left.kind === "directory" ? -1 : 1) || left.relativePath.localeCompare(right.relativePath))
  .slice(0, resultLimit)
  .map(entry => ({
    relativePath: entry.relativePath,
    absolutePath: entry.absolutePath,
    fileName: entry.fileName,
    kind: entry.kind,
    score: 0,
    indices: [],
  } satisfies FileSearchMatch))

export const searchEntries = (entries: readonly IndexedEntry[], query: string, resultLimit: number) => {
  const normalizedQuery = normalizeSearchQuery(query)
  if (!normalizedQuery) return browseEntries(entries, resultLimit)
  const matches: FileSearchMatch[] = []
  for (const entry of entries) {
    const match = matchPathQuery(entry.relativePath, normalizedQuery)
    if (!match) continue
    matches.push({
      relativePath: entry.relativePath,
      absolutePath: entry.absolutePath,
      fileName: entry.fileName,
      kind: entry.kind,
      score: match.score,
      indices: match.indices,
    })
  }
  matches.sort((left, right) => right.score - left.score || left.relativePath.localeCompare(right.relativePath))
  return matches.slice(0, resultLimit)
}

export const searchResultSignature = (query: string, matches: readonly FileSearchMatch[], walkComplete: boolean) =>
  `${normalizeSearchQuery(query)}|${walkComplete ? 1 : 0}|${matches.map(match => `${match.relativePath}:${match.kind}:${match.score}:${match.indices.join(",")}`).join("|")}`

export const crawlWorkspaceEntries = async (workspaceRoot: string, onEntry: (entry: IndexedEntry) => void, options: CrawlWorkspaceOptions = {}) => {
  const root = resolve(workspaceRoot)
  const rootReal = await realpath(root)
  const mounts = options.mountTable ? sortMountTable(options.mountTable) : await loadMountTable()
  const rootMount = findMountForPath(mounts, rootReal) ?? findMountForPath(mounts, root)
  const probeThresholdMs = options.probeThresholdMs ?? FILE_SEARCH_SLOW_MOUNT_MS
  const probeMount = options.probeMount ?? measureMountProbe
  const probeCache = new Map<string, MountProbeResult>()
  const classifyMount = async (mount: MountInfoEntry | null) => {
    if (!mount) return null
    const cached = probeCache.get(mount.mountPoint)
    if (cached) return cached
    const probeMs = await probeMount(mount)
    const result = { mount, probeMs, slow: isSlowMountProbe(probeMs, probeThresholdMs) } satisfies MountProbeResult
    probeCache.set(mount.mountPoint, result)
    return result
  }

  const rootProbe = await classifyMount(rootMount)
  if (rootProbe?.slow) throw new SlowSearchMountError(rootProbe.mount.mountPoint, rootProbe.probeMs)

  const stack: Array<{ absolutePath: string; ancestorReals: Set<string>; mount: MountInfoEntry | null }> = [{ absolutePath: root, ancestorReals: new Set([rootReal]), mount: rootMount }]

  while (stack.length) {
    const current = stack.pop()!
    const children = await readdir(current.absolutePath, { withFileTypes: true })
    for (const child of children) {
      if (shouldSkipSearchDirectory(child.name) && child.isDirectory()) continue
      const absolutePath = join(current.absolutePath, child.name)
      try {
        const info = await stat(absolutePath)
        if (info.isDirectory()) {
          if (shouldSkipSearchDirectory(child.name)) continue
          const resolvedPath = await realpath(absolutePath)
          if (current.ancestorReals.has(resolvedPath)) continue
          const childMount = findMountForPath(mounts, resolvedPath) ?? current.mount
          if (childMount && childMount.mountPoint !== current.mount?.mountPoint) {
            const probe = await classifyMount(childMount)
            if (probe?.slow) continue
          }
          const entry: IndexedEntry = {
            absolutePath,
            relativePath: normalizeRelativePath(relative(root, absolutePath)),
            fileName: child.name,
            kind: "directory",
          }
          onEntry(entry)
          const ancestorReals = new Set(current.ancestorReals)
          ancestorReals.add(resolvedPath)
          stack.push({ absolutePath, ancestorReals, mount: childMount })
          continue
        }
        if (info.isFile()) {
          onEntry({
            absolutePath,
            relativePath: normalizeRelativePath(relative(root, absolutePath)),
            fileName: child.name,
            kind: "file",
          })
        }
      } catch {
        continue
      }
    }
  }
}

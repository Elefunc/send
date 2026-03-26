import { access, mkdir, open, rename, rm, stat, type FileHandle } from "node:fs/promises"
import { basename, extname, join, resolve } from "node:path"
import { resolveUserPath } from "./paths"

export interface LocalFile {
  path: string
  name: string
  size: number
  type: string
  lastModified: number
  reader?: FileHandle
}

export type LocalFileInfo = Omit<LocalFile, "reader">
export interface LocalPathIssue {
  path: string
  error: string
}

export const pathExists = async (path: string) => access(path).then(() => true, () => false)

export const inspectLocalFile = async (path: string): Promise<LocalFileInfo> => {
  const absolute = resolveUserPath(path)
  const info = await stat(absolute)
  if (!info.isFile()) throw new Error(`not a file: ${absolute}`)
  const blob = Bun.file(absolute)
  return {
    path: absolute,
    name: basename(absolute),
    size: info.size,
    type: blob.type || "application/octet-stream",
    lastModified: Math.round(info.mtimeMs || Date.now()),
  }
}

export const inspectLocalPaths = async (paths: string[]) => {
  const results = await Promise.allSettled(paths.map(inspectLocalFile))
  const files: LocalFileInfo[] = []
  const errors: LocalPathIssue[] = []
  results.forEach((result, index) => {
    if (result.status === "fulfilled") {
      files.push(result.value)
      return
    }
    errors.push({
      path: resolveUserPath(paths[index] || ""),
      error: result.reason instanceof Error ? result.reason.message : `${result.reason}`,
    })
  })
  return { files, errors }
}

export const loadLocalFile = async (path: string): Promise<LocalFile> => {
  const info = await inspectLocalFile(path)
  return { ...info }
}

export const loadLocalFiles = (paths: string[]) => Promise.all(paths.map(loadLocalFile))

const readHandleChunk = async (handle: FileHandle, offset: number, size: number) => {
  const chunk = Buffer.allocUnsafe(size)
  let bytesReadTotal = 0
  while (bytesReadTotal < size) {
    const { bytesRead } = await handle.read(chunk, bytesReadTotal, size - bytesReadTotal, offset + bytesReadTotal)
    if (!bytesRead) break
    bytesReadTotal += bytesRead
  }
  return bytesReadTotal === size ? chunk : chunk.subarray(0, bytesReadTotal)
}

export const readFileChunk = async (file: LocalFile, offset: number, size: number) => {
  file.reader ||= await open(file.path, "r")
  return readHandleChunk(file.reader, offset, size)
}

export const closeLocalFile = async (file?: LocalFile) => {
  if (!file?.reader) return
  const reader = file.reader
  file.reader = undefined
  await reader.close()
}

export const writeFileChunk = async (handle: FileHandle, data: Buffer, offset: number) => {
  let bytesWrittenTotal = 0
  while (bytesWrittenTotal < data.byteLength) {
    const { bytesWritten } = await handle.write(data, bytesWrittenTotal, data.byteLength - bytesWrittenTotal, offset + bytesWrittenTotal)
    if (!bytesWritten) throw new Error("short write")
    bytesWrittenTotal += bytesWritten
  }
  return bytesWrittenTotal
}

export const uniqueOutputPath = async (directory: string, fileName: string, reservedPaths: ReadonlySet<string> = new Set()) => {
  await mkdir(directory, { recursive: true })
  const extension = extname(fileName)
  const stem = extension ? fileName.slice(0, -extension.length) : fileName
  for (let index = 0; ; index += 1) {
    const candidate = join(directory, index ? `${stem} (${index})${extension}` : fileName)
    if (reservedPaths.has(candidate)) continue
    if (!await pathExists(candidate)) return candidate
  }
}

export const incomingOutputPath = async (directory: string, fileName: string, overwrite = false, reservedPaths: ReadonlySet<string> = new Set()) => {
  await mkdir(directory, { recursive: true })
  return overwrite ? join(directory, fileName) : uniqueOutputPath(directory, fileName, reservedPaths)
}

export const replaceOutputPath = async (sourcePath: string, destinationPath: string) => {
  try {
    await rename(sourcePath, destinationPath)
  } catch (error) {
    if (!await pathExists(destinationPath)) throw error
    await removePath(destinationPath)
    await rename(sourcePath, destinationPath)
  }
}

export const saveIncomingFile = async (directory: string, fileName: string, data: Buffer, overwrite = false) => {
  const path = await incomingOutputPath(directory, fileName, overwrite)
  await Bun.write(path, data)
  return path
}

export const removePath = async (path: string) => {
  await rm(path, { force: true }).catch(() => {})
}

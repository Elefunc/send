import { access, mkdir, stat } from "node:fs/promises"
import { basename, extname, join, resolve } from "node:path"
import { resolveUserPath } from "./paths"

export interface LocalFile {
  path: string
  name: string
  size: number
  type: string
  lastModified: number
  blob: Blob
}

export type LocalFileInfo = Omit<LocalFile, "blob">
export interface LocalPathIssue {
  path: string
  error: string
}

const exists = async (path: string) => access(path).then(() => true, () => false)

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
  return {
    ...info,
    blob: Bun.file(info.path),
  }
}

export const loadLocalFiles = (paths: string[]) => Promise.all(paths.map(loadLocalFile))

export const readFileChunk = async (file: LocalFile, offset: number, size: number) => Buffer.from(await file.blob.slice(offset, offset + size).arrayBuffer())

export const uniqueOutputPath = async (directory: string, fileName: string) => {
  await mkdir(directory, { recursive: true })
  const extension = extname(fileName)
  const stem = extension ? fileName.slice(0, -extension.length) : fileName
  for (let index = 0; ; index += 1) {
    const candidate = join(directory, index ? `${stem} (${index})${extension}` : fileName)
    if (!await exists(candidate)) return candidate
  }
}

export const saveIncomingFile = async (directory: string, fileName: string, data: Buffer) => {
  const path = await uniqueOutputPath(directory, fileName)
  await Bun.write(path, data)
  return path
}

import { describe, expect, test } from "bun:test"
import { mkdir, rm } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { closeLocalFile, inspectLocalFile, inspectLocalPaths, loadLocalFile, readFileChunk, saveIncomingFile, writeFileChunk } from "../src/core/files"

describe("saveIncomingFile", () => {
  test("creates collision-safe file names", async () => {
    const dir = join(process.cwd(), ".tmp-send-cli-test")
    await rm(dir, { recursive: true, force: true })
    await mkdir(dir, { recursive: true })
    const first = await saveIncomingFile(dir, "hello.txt", Buffer.from("one"))
    const second = await saveIncomingFile(dir, "hello.txt", Buffer.from("two"))
    expect(first.endsWith("hello.txt")).toBe(true)
    expect(second.endsWith("hello (1).txt")).toBe(true)
    await rm(dir, { recursive: true, force: true })
  })

  test("overwrites the same path when overwrite mode is enabled", async () => {
    const dir = join(process.cwd(), ".tmp-send-cli-overwrite")
    await rm(dir, { recursive: true, force: true })
    await mkdir(dir, { recursive: true })
    const first = await saveIncomingFile(dir, "hello.txt", Buffer.from("one"), true)
    const second = await saveIncomingFile(dir, "hello.txt", Buffer.from("two"), true)
    expect(first).toBe(second)
    expect(second.endsWith("hello.txt")).toBe(true)
    expect(await Bun.file(second).text()).toBe("two")
    await rm(dir, { recursive: true, force: true })
  })
})

describe("readFileChunk", () => {
  test("reads the exact requested byte ranges", async () => {
    const dir = join(process.cwd(), ".tmp-send-cli-read-chunk")
    await rm(dir, { recursive: true, force: true })
    await mkdir(dir, { recursive: true })
    const path = join(dir, "hello.bin")
    const data = Buffer.alloc(150_123)
    for (let index = 0; index < data.length; index += 1) data[index] = index % 251
    await Bun.write(path, data)

    const file = await loadLocalFile(path)
    const chunks: Buffer[] = []
    for (let offset = 0; offset < file.size; offset += 65536) chunks.push(await readFileChunk(file, offset, 65536))

    expect(Buffer.concat(chunks)).toEqual(data)
    await closeLocalFile(file)
    await rm(dir, { recursive: true, force: true })
  })

  test("retries short reads until the requested chunk is filled", async () => {
    const source = Buffer.from("hello")
    const file = {
      path: "",
      name: "hello.txt",
      size: source.byteLength,
      type: "text/plain",
      lastModified: 0,
      reader: {
        read: async (chunk: Buffer, start: number, length: number, position: number) => {
          const bytesRead = Math.min(2, length, Math.max(0, source.byteLength - position))
          if (bytesRead) source.copy(chunk, start, position, position + bytesRead)
          return { bytesRead, buffer: chunk }
        },
      },
    } as any

    expect(await readFileChunk(file, 0, source.byteLength)).toEqual(source)
  })
})

describe("writeFileChunk", () => {
  test("retries short writes until the whole buffer is written", async () => {
    const target = Buffer.alloc(5)
    const handle = {
      write: async (data: Buffer, start: number, length: number, position: number) => {
        const bytesWritten = Math.min(2, length)
        data.copy(target, position, start, start + bytesWritten)
        return { bytesWritten, buffer: data }
      },
    } as any

    expect(await writeFileChunk(handle, Buffer.from("hello"), 0)).toBe(5)
    expect(target.toString("utf8")).toBe("hello")
  })
})

describe("inspectLocalPaths", () => {
  test("collects valid files and reports invalid paths", async () => {
    const dir = join(process.cwd(), ".tmp-send-cli-paths")
    await rm(dir, { recursive: true, force: true })
    await mkdir(dir, { recursive: true })
    const file = join(dir, "hello.txt")
    const folder = join(dir, "nested")
    await Bun.write(file, "hello")
    await mkdir(folder, { recursive: true })

    const result = await inspectLocalPaths([file, folder, join(dir, "missing.txt")])

    expect(result.files.length).toBe(1)
    expect(result.files[0]?.path).toBe(file)
    expect(result.files[0]?.name).toBe("hello.txt")
    expect(result.files[0]?.size).toBe(5)
    expect(result.errors.length).toBe(2)
    expect(result.errors.some(issue => issue.path === folder && issue.error.includes("not a file"))).toBe(true)
    expect(result.errors.some(issue => issue.path.endsWith("missing.txt"))).toBe(true)
    await rm(dir, { recursive: true, force: true })
  })
})

describe("inspectLocalFile", () => {
  test("expands ~ to the current user's home directory", async () => {
    const dir = join(homedir(), ".tmp-send-cli-home-paths")
    await rm(dir, { recursive: true, force: true })
    await mkdir(dir, { recursive: true })
    const file = join(dir, "hello.txt")
    await Bun.write(file, "hello")

    const result = await inspectLocalFile("~/.tmp-send-cli-home-paths/hello.txt")

    expect(result.path).toBe(file)
    expect(result.name).toBe("hello.txt")
    expect(result.size).toBe(5)
    await rm(dir, { recursive: true, force: true })
  })
})

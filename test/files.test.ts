import { describe, expect, test } from "bun:test"
import { mkdir, rm } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { inspectLocalFile, inspectLocalPaths, saveIncomingFile } from "../src/core/files"

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

import { describe, expect, test } from "bun:test"
import { mkdir, rm, symlink } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { FILE_SEARCH_SLOW_MOUNT_MS, SlowSearchMountError, crawlWorkspaceEntries, deriveFileSearchScope, findMountForPath, formatFileSearchDisplayPath, isSlowMountProbe, matchPathQuery, normalizeSearchQuery, offsetFileSearchMatchIndices, parseMountInfo, searchEntries, shouldSkipSearchDirectory } from "../src/tui/file-search"

describe("file search query helpers", () => {
  test("parses mount info and resolves the longest matching mount prefix", () => {
    const mounts = parseMountInfo([
      "38 27 0:35 / / rw,relatime - ext4 /dev/root rw",
      "71 38 0:47 / /mnt rw,relatime - drvfs C: rw",
      "86 71 0:47 /Users/cetin /mnt/c/Users/cetin rw,relatime - drvfs C: rw",
    ].join("\n"))
    expect(mounts.map(mount => mount.mountPoint)).toEqual(["/mnt/c/Users/cetin", "/mnt", "/"])
    expect(findMountForPath(mounts, "/mnt/c/Users/cetin/project/file.txt")?.mountPoint).toBe("/mnt/c/Users/cetin")
    expect(findMountForPath(mounts, "/mnt/d/cache")?.mountPoint).toBe("/mnt")
    expect(findMountForPath(mounts, "/tmp/example")?.mountPoint).toBe("/")
  })

  test("classifies slow mounts using the configured latency threshold", () => {
    expect(isSlowMountProbe(FILE_SEARCH_SLOW_MOUNT_MS - 1)).toBe(false)
    expect(isSlowMountProbe(FILE_SEARCH_SLOW_MOUNT_MS)).toBe(true)
    expect(isSlowMountProbe(120, 200)).toBe(false)
    expect(isSlowMountProbe(220, 200)).toBe(true)
  })

  test("normalizes separators and only trims trailing CRLF", () => {
    expect(normalizeSearchQuery("src\\main.ts\r\n")).toBe("src/main.ts")
    expect(normalizeSearchQuery("docs/My File.md")).toBe("docs/My File.md")
  })

  test("matches ordered subsequences and scores basename prefixes first", () => {
    expect(matchPathQuery("src/main.ts", "srcmn")?.indices).toEqual([0, 1, 2, 4, 7])
    expect(matchPathQuery("src/main.ts", "mna")).toBe(null)
    const basenamePrefix = matchPathQuery("src/main.ts", "main")
    const laterMatch = matchPathQuery("src/domain.ts", "main")
    expect((basenamePrefix?.score ?? 0) > (laterMatch?.score ?? 0)).toBe(true)
  })

  test("sorts matches by score then ascending relative path", () => {
    const matches = searchEntries([
      { absolutePath: "/tmp/src/main.test.ts", relativePath: "src/main.test.ts", fileName: "main.test.ts", kind: "file", size: 2048 },
      { absolutePath: "/tmp/src/main.ts", relativePath: "src/main.ts", fileName: "main.ts", kind: "file", size: 1024 },
      { absolutePath: "/tmp/docs/domain.md", relativePath: "docs/domain.md", fileName: "domain.md", kind: "file", size: 4096 },
    ], "main", 20)
    expect(matches.map(match => match.relativePath)).toEqual(["src/main.ts", "src/main.test.ts", "docs/domain.md"])
    expect(matches.map(match => match.size)).toEqual([1024, 2048, 4096])
  })

  test("derives preview scopes for relative, traversal, absolute, and home inputs", () => {
    expect(deriveFileSearchScope("src/main", "/workspace")).toEqual({
      normalizedInput: "src/main",
      workspaceRoot: "/workspace/src",
      displayPrefix: "src/",
      query: "main",
    })
    expect(deriveFileSearchScope("../downloads/file", "/workspace/app")).toEqual({
      normalizedInput: "../downloads/file",
      workspaceRoot: "/workspace/downloads",
      displayPrefix: "../downloads/",
      query: "file",
    })
    expect(deriveFileSearchScope("/tmp/cache/", "/workspace")).toEqual({
      normalizedInput: "/tmp/cache/",
      workspaceRoot: "/tmp/cache",
      displayPrefix: "/tmp/cache/",
      query: "",
    })
    expect(deriveFileSearchScope("~", "/workspace")).toEqual({
      normalizedInput: "~",
      workspaceRoot: homedir(),
      displayPrefix: "~",
      query: "",
    })
    expect(deriveFileSearchScope("~/downloads/file", "/workspace")).toEqual({
      normalizedInput: "~/downloads/file",
      workspaceRoot: join(homedir(), "downloads"),
      displayPrefix: "~/downloads/",
      query: "file",
    })
  })

  test("formats display paths and highlight offsets using the typed prefix style", () => {
    expect(formatFileSearchDisplayPath("", "src/main.ts")).toBe("src/main.ts")
    expect(formatFileSearchDisplayPath("../downloads/", "main.ts")).toBe("../downloads/main.ts")
    expect(formatFileSearchDisplayPath("/", "tmp")).toBe("/tmp")
    expect(formatFileSearchDisplayPath("~", "notes.txt")).toBe("~/notes.txt")
    expect(offsetFileSearchMatchIndices("../", [0, 2, 4])).toEqual([3, 5, 7])
    expect(offsetFileSearchMatchIndices("~", [0, 2, 4])).toEqual([2, 4, 6])
  })

  test("lists only direct children when browsing a directory with an empty query", () => {
    const matches = searchEntries([
      { absolutePath: "/tmp/alpha", relativePath: "alpha", fileName: "alpha", kind: "directory" },
      { absolutePath: "/tmp/bravo.ts", relativePath: "bravo.ts", fileName: "bravo.ts", kind: "file", size: 512 },
      { absolutePath: "/tmp/src/main.ts", relativePath: "src/main.ts", fileName: "main.ts", kind: "file", size: 1024 },
    ], "", 20)
    expect(matches.map(match => `${match.kind}:${match.relativePath}`)).toEqual([
      "directory:alpha",
      "file:bravo.ts",
    ])
    expect(matches.map(match => match.size ?? null)).toEqual([null, 512])
  })
})

describe("file search crawler", () => {
  test("indexes files and directories while skipping .git and node_modules", async () => {
    const root = join(process.cwd(), ".tmp-send-cli-search")
    await rm(root, { recursive: true, force: true })
    await mkdir(join(root, "src", "feature"), { recursive: true })
    await mkdir(join(root, ".git", "objects"), { recursive: true })
    await mkdir(join(root, "node_modules", "left-pad"), { recursive: true })
    await Bun.write(join(root, "src", "main.ts"), "export {}")
    await Bun.write(join(root, "src", "feature", "flags.ts"), "export const flags = true")
    await Bun.write(join(root, ".git", "HEAD"), "ref: refs/heads/main")
    await Bun.write(join(root, "node_modules", "left-pad", "index.js"), "module.exports = {}")
    const entries: string[] = []

    await crawlWorkspaceEntries(root, entry => {
      entries.push(`${entry.kind}:${entry.relativePath}`)
    })

    expect(entries).toContain("directory:src")
    expect(entries).toContain("directory:src/feature")
    expect(entries).toContain("file:src/main.ts")
    expect(entries).toContain("file:src/feature/flags.ts")
    expect(entries.some(entry => entry.includes(".git"))).toBe(false)
    expect(entries.some(entry => entry.includes("node_modules"))).toBe(false)
    await rm(root, { recursive: true, force: true })
  })

  test("records sizes for file entries but not directories", async () => {
    const root = join(process.cwd(), ".tmp-send-cli-search-sizes")
    await rm(root, { recursive: true, force: true })
    await mkdir(join(root, "src"), { recursive: true })
    await Bun.write(join(root, "src", "main.ts"), "export {}")
    const entries: Array<{ kind: string; relativePath: string; size?: number }> = []

    try {
      await crawlWorkspaceEntries(root, entry => {
        entries.push({ kind: entry.kind, relativePath: entry.relativePath, size: entry.size })
      })

      expect(entries.find(entry => entry.kind === "directory" && entry.relativePath === "src")?.size).toBe(undefined)
      expect(entries.find(entry => entry.kind === "file" && entry.relativePath === "src/main.ts")?.size).toBe(9)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("follows symlinked directories without recursing forever", async () => {
    const root = join(process.cwd(), ".tmp-send-cli-search-links")
    await rm(root, { recursive: true, force: true })
    await mkdir(join(root, "src"), { recursive: true })
    await Bun.write(join(root, "src", "main.ts"), "export {}")
    await symlink(join(root, "src"), join(root, "src-link"), "dir")
    const entries: string[] = []

    await crawlWorkspaceEntries(root, entry => {
      entries.push(`${entry.kind}:${entry.relativePath}`)
    })

    expect(entries).toContain("directory:src-link")
    expect(entries).toContain("file:src-link/main.ts")
    expect(entries.filter(entry => entry === "file:src/main.ts").length).toBe(1)
    await rm(root, { recursive: true, force: true })
  })

  test("skips symlinked directories when their visible name is in the skip set", async () => {
    const root = join(process.cwd(), ".tmp-send-cli-search-skipped-links")
    await rm(root, { recursive: true, force: true })
    await mkdir(join(root, "src"), { recursive: true })
    await Bun.write(join(root, "src", "main.ts"), "export {}")
    await symlink(join(root, "src"), join(root, "node_modules"), "dir")
    const entries: string[] = []

    await crawlWorkspaceEntries(root, entry => {
      entries.push(`${entry.kind}:${entry.relativePath}`)
    })

    expect(entries).toContain("directory:src")
    expect(entries).toContain("file:src/main.ts")
    expect(entries.some(entry => entry.includes("node_modules"))).toBe(false)
    await rm(root, { recursive: true, force: true })
  })

  test("exposes the minimal skip set", () => {
    expect(shouldSkipSearchDirectory(".git")).toBe(true)
    expect(shouldSkipSearchDirectory("node_modules")).toBe(true)
    expect(shouldSkipSearchDirectory("dist")).toBe(false)
  })

  test("fails preview crawling when the root mount is measured as slow", async () => {
    const root = join(process.cwd(), ".tmp-send-cli-search-slow-root")
    await rm(root, { recursive: true, force: true })
    await mkdir(root, { recursive: true })
    await Bun.write(join(root, "main.ts"), "export {}")

    try {
      let error: unknown = null
      try {
        await crawlWorkspaceEntries(root, () => {}, {
          mountTable: [{ mountPoint: root, fsType: "fuse.sshfs", source: "remote" }],
          probeMount: async mount => mount.mountPoint === root ? FILE_SEARCH_SLOW_MOUNT_MS + 75 : 5,
        })
      } catch (caught) {
        error = caught
      }
      expect(error instanceof SlowSearchMountError).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("skips nested slow mounts while continuing to crawl local entries", async () => {
    const root = join(process.cwd(), ".tmp-send-cli-search-slow-submount")
    const localDir = join(root, "src")
    const remoteDir = join(root, "remote")
    await rm(root, { recursive: true, force: true })
    await mkdir(localDir, { recursive: true })
    await mkdir(remoteDir, { recursive: true })
    await Bun.write(join(localDir, "main.ts"), "export {}")
    await Bun.write(join(remoteDir, "slow.ts"), "export {}")
    const entries: string[] = []

    try {
      await crawlWorkspaceEntries(root, entry => {
        entries.push(`${entry.kind}:${entry.relativePath}`)
      }, {
        mountTable: [
          { mountPoint: remoteDir, fsType: "fuse.sshfs", source: "remote" },
          { mountPoint: root, fsType: "ext4", source: "/dev/root" },
        ],
        probeMount: async mount => mount.mountPoint === remoteDir ? FILE_SEARCH_SLOW_MOUNT_MS + 25 : 5,
      })

      expect(entries).toContain("directory:src")
      expect(entries).toContain("file:src/main.ts")
      expect(entries.some(entry => entry.includes("remote"))).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

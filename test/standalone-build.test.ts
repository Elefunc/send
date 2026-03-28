import { describe, expect, test } from "bun:test"
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { mkdtempSync } from "node:fs"
import {
  buildRuntimeArchive,
  collectRuntimeFiles,
  extractRuntimeArchive,
  renderStandaloneBootstrapSource,
  runExtractedRuntime,
  shouldIncludeRuntimePath,
} from "../scripts/standalone-lib"
import {
  standaloneCompileTargets,
  standaloneTargetToArtifactName,
  standaloneTargetToBasename,
} from "../scripts/build-standalone-all"
import { parseBuildArgs } from "../scripts/build-standalone"

describe("standalone builder", () => {
  test("runtime path filter keeps only shipped runtime files", () => {
    expect(shouldIncludeRuntimePath("package.json")).toBe(true)
    expect(shouldIncludeRuntimePath("src/index.ts")).toBe(true)
    expect(shouldIncludeRuntimePath("runtime/install.ts")).toBe(true)
    expect(shouldIncludeRuntimePath("node_modules/cac/dist/index.js")).toBe(true)
    expect(shouldIncludeRuntimePath("node_modules/.bin/send")).toBe(false)
    expect(shouldIncludeRuntimePath("test/session.test.ts")).toBe(false)
    expect(shouldIncludeRuntimePath("downloads/tmp.bin")).toBe(false)
    expect(shouldIncludeRuntimePath("../escape.ts")).toBe(false)
  })

  test("archive round-trips the staged runtime tree", async () => {
    const root = mkdtempSync(join(tmpdir(), "send-standalone-archive-"))
    const archivePath = join(root, "runtime.bin")
    const extractRoot = join(root, "extract")
    try {
      mkdirSync(join(root, "src"), { recursive: true })
      mkdirSync(join(root, "runtime"), { recursive: true })
      mkdirSync(join(root, "node_modules/pkg"), { recursive: true })
      mkdirSync(join(root, "node_modules/.bin"), { recursive: true })
      writeFileSync(join(root, "package.json"), '{"type":"module"}\n')
      writeFileSync(join(root, "src/index.ts"), 'console.log("ok")\n')
      writeFileSync(join(root, "runtime/install.ts"), "export {}\n")
      writeFileSync(join(root, "node_modules/pkg/index.js"), "export default 1\n")
      writeFileSync(join(root, "node_modules/.bin/skip"), "skip\n")
      symlinkSync("../pkg/index.js", join(root, "node_modules/.bin/pkg"), "file")

      const files = collectRuntimeFiles(root)
      expect(files.map(file => file.relativePath)).toEqual([
        "node_modules/pkg/index.js",
        "package.json",
        "runtime/install.ts",
        "src/index.ts",
      ])

      buildRuntimeArchive(root, archivePath)
      await extractRuntimeArchive(archivePath, extractRoot)

      expect(readFileSync(join(extractRoot, "package.json"), "utf8")).toContain('"type":"module"')
      expect(readFileSync(join(extractRoot, "src/index.ts"), "utf8")).toContain('console.log("ok")')
      expect(readFileSync(join(extractRoot, "runtime/install.ts"), "utf8")).toContain("export {}")
      expect(readFileSync(join(extractRoot, "node_modules/pkg/index.js"), "utf8")).toContain("export default 1")
      let missingFileError: Error | null = null
      try {
        readFileSync(join(extractRoot, "node_modules/.bin/skip"), "utf8")
      } catch (error) {
        missingFileError = error as Error
      }
      expect(missingFileError instanceof Error).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("bootstrap source re-execs the extracted runtime", () => {
    const source = renderStandaloneBootstrapSource({
      archiveImportPath: "./runtime.bin",
      entrypointRelativePath: "src/index.ts",
      helperImportPath: "../scripts/standalone-lib.ts",
      packageName: "@elefunc/send",
      packageVersion: "0.1.19",
      runtimeHash: "deadbeefcafe",
    })
    expect(source).toContain('import runtimeArchive from "./runtime.bin" with { type: "file" }')
    expect(source).toContain('entrypointRelativePath: "src/index.ts"')
    expect(source).toContain("process.exit(exitCode)")
  })

  test("runExtractedRuntime reuses bun CLI against an extracted tree", () => {
    const root = mkdtempSync(join(tmpdir(), "send-standalone-run-"))
    try {
      mkdirSync(join(root, "src"), { recursive: true })
      writeFileSync(join(root, "package.json"), '{"type":"module"}\n')
      writeFileSync(join(root, "src/index.ts"), 'console.log(JSON.stringify({ args: process.argv.slice(2) }))\n')
      const result = runExtractedRuntime({
        args: ["alpha", "beta"],
        entrypointRelativePath: "src/index.ts",
        runtimeRoot: root,
        stdio: "pipe",
      })
      expect(result.error).toBe(undefined)
      expect(result.status).toBe(0)
      expect(result.stdout.toString("utf8").trim()).toBe('{"args":["alpha","beta"]}')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("build script parses outfile and target options", () => {
    const options = parseBuildArgs(["--outfile", "dist/send-bin", "--target", "bun-linux-x64", "--keep-temp"])
    expect(options.keepTemp).toBe(true)
    expect(options.outfile.endsWith("/dist/send-bin")).toBe(true)
    expect(options.target).toBe("bun-linux-x64")
  })

  test("all-target builder locks the full Bun target matrix", () => {
    expect(standaloneCompileTargets).toEqual([
      "bun-darwin-x64",
      "bun-darwin-x64-baseline",
      "bun-darwin-x64-modern",
      "bun-darwin-arm64",
      "bun-linux-x64",
      "bun-linux-x64-baseline",
      "bun-linux-x64-modern",
      "bun-linux-arm64",
      "bun-linux-x64-musl",
      "bun-linux-x64-musl-baseline",
      "bun-linux-x64-musl-modern",
      "bun-linux-arm64-musl",
      "bun-windows-x64",
      "bun-windows-x64-baseline",
      "bun-windows-x64-modern",
      "bun-windows-arm64",
    ])
  })

  test("all-target builder maps Bun targets to output basenames", () => {
    expect(standaloneTargetToBasename("bun-linux-x64")).toBe("send-linux-x64")
    expect(standaloneTargetToBasename("bun-linux-x64-musl-baseline")).toBe("send-linux-x64-musl-baseline")
    expect(standaloneTargetToBasename("bun-darwin-x64-modern")).toBe("send-darwin-x64-modern")
  })

  test("all-target builder applies Windows executable suffix only to final artifact names", () => {
    expect(standaloneTargetToBasename("bun-windows-x64")).toBe("send-windows-x64")
    expect(standaloneTargetToArtifactName("bun-windows-x64")).toBe("send-windows-x64.exe")
    expect(standaloneTargetToArtifactName("bun-linux-arm64")).toBe("send-linux-arm64")
  })
})

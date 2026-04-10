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
  assertStandaloneAllHostSupported,
  hasWindowsStandaloneTargets,
  standaloneCompileTargets,
  standaloneTargetToArtifactName,
  standaloneTargetToBasename,
} from "../scripts/build-standalone-all"
import {
  assertWindowsIconAssetExists,
  assertWindowsBuildHostSupported,
  buildStandaloneCompileArgs,
  getWindowsBuildMetadataArgs,
  isInternalWindowsBridgeRun,
  isWindowsCompileTarget,
  isWsl2Host,
  normalizeWindowsVersion,
  parseBuildArgs,
  renderWslWindowsBridgeScript,
  standaloneArtifactPathFromOutfile,
  windowsBridgeArtifactPaths,
  WINDOWS_BRIDGE_ENV,
  WINDOWS_ICON_PATH,
} from "../scripts/build-standalone"

const errorMessage = (action: () => unknown) => {
  try {
    action()
    return ""
  } catch (error) {
    return error instanceof Error ? error.message : `${error}`
  }
}

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

  test("detects Windows builds from explicit targets and native Windows defaults", () => {
    expect(isWindowsCompileTarget("bun-windows-x64", "linux")).toBe(true)
    expect(isWindowsCompileTarget("bun-linux-x64", "win32")).toBe(false)
    expect(isWindowsCompileTarget(undefined, "win32")).toBe(true)
    expect(isWindowsCompileTarget(undefined, "linux")).toBe(false)
  })

  test("detects WSL2 hosts and the internal Windows bridge environment", () => {
    expect(isWsl2Host("linux", { WSL_DISTRO_NAME: "Ubuntu", WSL_INTEROP: "/run/WSL/1" }, "Linux version 6.6.87.2-microsoft-standard-WSL2")).toBe(true)
    expect(isWsl2Host("linux", {}, "Linux version 6.6.87.2-generic")).toBe(false)
    expect(isInternalWindowsBridgeRun({ [WINDOWS_BRIDGE_ENV]: "1" })).toBe(true)
    expect(isInternalWindowsBridgeRun({})).toBe(false)
  })

  test("allows Windows builds only from WSL2 or the internal Windows bridge", () => {
    expect(errorMessage(() => assertWindowsBuildHostSupported(
      "bun-windows-x64",
      "linux",
      { WSL_DISTRO_NAME: "Ubuntu", WSL_INTEROP: "/run/WSL/1" },
      "Linux version 6.6.87.2-microsoft-standard-WSL2",
    ))).toBe("")
    expect(errorMessage(() => assertWindowsBuildHostSupported("bun-windows-x64", "win32", { [WINDOWS_BRIDGE_ENV]: "1" }))).toBe("")
    expect(errorMessage(() => assertWindowsBuildHostSupported("bun-windows-x64", "linux", {}, "Linux version 6.6.87.2-generic")))
      .toContain("require WSL2")
    expect(errorMessage(() => assertWindowsBuildHostSupported("bun-windows-x64", "win32", {})))
      .toContain("must be launched from WSL2")
  })

  test("validates Windows executable versions from package.json", () => {
    expect(normalizeWindowsVersion("0.1.19")).toBe("0.1.19")
    expect(normalizeWindowsVersion("1.2.3.4")).toBe("1.2.3.4")
    expect(errorMessage(() => normalizeWindowsVersion("0.1.19-beta.1"))).toContain("package.json version must be a dotted numeric Windows version")
  })

  test("adds rtme.sh metadata flags for Windows targets", () => {
    const args = getWindowsBuildMetadataArgs(
      { description: "Browser-compatible file transfer CLI and TUI powered by Bun, WebRTC, and Rezi.", version: "0.1.19" },
      "bun-windows-x64",
      "win32",
    )
    expect(args).toEqual([
      "--windows-title", "rtme.sh",
      "--windows-publisher", "Elefunc, Inc.",
      "--windows-version", "0.1.19",
      "--windows-description", "Browser-compatible file transfer CLI and TUI powered by Bun, WebRTC, and Rezi.",
      "--windows-copyright", "Copyright (c) Elefunc, Inc.",
      "--windows-icon", WINDOWS_ICON_PATH,
    ])
  })

  test("omits Windows metadata flags for non-Windows targets", () => {
    expect(getWindowsBuildMetadataArgs({ description: "desc", version: "0.1.19" }, "bun-linux-x64", "linux")).toEqual([])
  })

  test("fails fast when the Windows icon asset is missing", () => {
    expect(errorMessage(() => assertWindowsIconAssetExists("bun-windows-x64", "/tmp/missing-icon.ico", "win32")))
      .toContain("Missing Windows icon asset")
  })

  test("refuses Windows metadata stamping on non-Windows hosts", () => {
    expect(errorMessage(() => getWindowsBuildMetadataArgs({ description: "desc", version: "0.1.19" }, "bun-windows-x64", "linux")))
      .toContain("Windows standalone builds must run on Windows")
  })

  test("fails Windows metadata assembly when the icon asset is missing", () => {
    expect(errorMessage(() => getWindowsBuildMetadataArgs(
      { description: "desc", version: "0.1.19" },
      "bun-windows-x64",
      "win32",
      "/tmp/missing-icon.ico",
    ))).toContain("Missing Windows icon asset")
  })

  test("treats omitted target on Windows as a Windows executable build", () => {
    const args = buildStandaloneCompileArgs({
      bootstrapPath: "/tmp/bootstrap.ts",
      hostPlatform: "win32",
      outfile: "/tmp/send",
      packageJson: { description: "desc", version: "0.1.19" },
    })
    expect(args).toEqual([
      "build", "--compile", "/tmp/bootstrap.ts", "--outfile", "/tmp/send",
      "--windows-title", "rtme.sh",
      "--windows-publisher", "Elefunc, Inc.",
      "--windows-version", "0.1.19",
      "--windows-description", "desc",
      "--windows-copyright", "Copyright (c) Elefunc, Inc.",
      "--windows-icon", WINDOWS_ICON_PATH,
    ])
  })

  test("renders a PowerShell bridge script for WSL Windows builds", () => {
    const script = renderWslWindowsBridgeScript({
      keepTemp: true,
      outfileWin: "C:\\temp\\send.exe",
      packageRootWin: "C:\\repo\\cli",
      skipSign: true,
      target: "bun-windows-x64",
    })
    expect(script).toContain(`$env:${WINDOWS_BRIDGE_ENV} = '1'`)
    expect(script).toContain(`$env:SEND_STANDALONE_SKIP_WINDOWS_SIGN = '1'`)
    expect(script).toContain(`Set-Location 'C:\\repo\\cli'`)
    expect(script).toContain(`'--outfile', 'C:\\temp\\send.exe'`)
    expect(script).toContain(`'--target', 'bun-windows-x64'`)
  })

  test("derives the final standalone artifact path from the outfile", () => {
    expect(standaloneArtifactPathFromOutfile("/tmp/send", "bun-windows-x64", "win32")).toBe("/tmp/send.exe")
    expect(standaloneArtifactPathFromOutfile("/tmp/send.exe", "bun-windows-x64", "win32")).toBe("/tmp/send.exe")
    expect(standaloneArtifactPathFromOutfile("/tmp/send", "bun-linux-x64", "linux")).toBe("/tmp/send")
  })

  test("stages WSL Windows bridge artifacts in Windows temp before copying them to the requested output", () => {
    const paths = windowsBridgeArtifactPaths(
      "/tmp/release/out/send-windows-x64",
      "bun-windows-x64",
      "/mnt/c/Users/cetin/AppData/Local/Temp/send-standalone-windows-abcd1234",
    )
    expect(paths).toEqual({
      stageOutfile: "/mnt/c/Users/cetin/AppData/Local/Temp/send-standalone-windows-abcd1234/send-windows-x64",
      stageArtifactPath: "/mnt/c/Users/cetin/AppData/Local/Temp/send-standalone-windows-abcd1234/send-windows-x64.exe",
      finalArtifactPath: "/tmp/release/out/send-windows-x64.exe",
    })
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

  test("all-target builder detects Windows entries in the matrix", () => {
    expect(hasWindowsStandaloneTargets(standaloneCompileTargets)).toBe(true)
    expect(hasWindowsStandaloneTargets(["bun-linux-x64", "bun-darwin-arm64"])).toBe(false)
  })

  test("all-target builder refuses the mixed matrix on non-Windows hosts", () => {
    expect(errorMessage(() => assertStandaloneAllHostSupported(
      standaloneCompileTargets,
      "linux",
      { WSL_DISTRO_NAME: "Ubuntu", WSL_INTEROP: "/run/WSL/1" },
      "Linux version 6.6.87.2-microsoft-standard-WSL2",
    ))).toBe("")
    expect(errorMessage(() => assertStandaloneAllHostSupported(standaloneCompileTargets, "linux", {}, "Linux version 6.6.87.2-generic")))
      .toContain("expects to run from WSL2")
    expect(errorMessage(() => assertStandaloneAllHostSupported(["bun-linux-x64"], "linux"))).toBe("")
  })
})

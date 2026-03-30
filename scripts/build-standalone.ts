import { spawnSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { buildRuntimeArchive, renderStandaloneBootstrapSource } from "./standalone-lib"

type BuildOptions = {
  keepTemp: boolean
  outfile: string
  target?: string
}

type PackageJsonShape = {
  description: string
  name: string
  version: string
}

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const WINDOWS_PRODUCT_NAME = "rtme.sh"
const WINDOWS_PUBLISHER = "Elefunc, Inc."
const WINDOWS_COPYRIGHT = "Copyright (c) Elefunc, Inc."
const WINDOWS_VERSION_PATTERN = /^\d+(?:\.\d+){0,3}$/
const WINDOWS_ICON_RELATIVE_PATH = "assets/windows-app-icon.ico"
export const WINDOWS_BRIDGE_ENV = "SEND_STANDALONE_WINDOWS_BRIDGE"
export const WINDOWS_SKIP_SIGN_ENV = "SEND_STANDALONE_SKIP_WINDOWS_SIGN"
export const WINDOWS_PREREQS_CHECKED_ENV = "SEND_STANDALONE_WSL_PREREQS_CHECKED"
const WINDOWS_SIGN_HELPER_PATH = join(packageRoot, "scripts/sign-pe-from-wsl.sh")
export const WINDOWS_ICON_PATH = join(packageRoot, WINDOWS_ICON_RELATIVE_PATH)
const WSL_SIGNING_COMMANDS = ["az", "cs", "cp", "mktemp", "powershell.exe", "realpath", "sha256sum", "stat", "wslpath"] as const

const toImportSpecifier = (fromDir: string, targetPath: string) => {
  const relativePath = relative(fromDir, targetPath).replaceAll("\\", "/")
  return relativePath.startsWith(".") ? relativePath : `./${relativePath}`
}

export const parseBuildArgs = (argv: readonly string[]): BuildOptions => {
  let keepTemp = false
  let outfile = resolve(packageRoot, "out/send")
  let target: string | undefined
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === "--keep-temp") {
      keepTemp = true
      continue
    }
    if (arg === "--outfile") {
      const value = argv[index + 1]
      if (!value) throw new Error("Missing value for --outfile")
      outfile = resolve(packageRoot, value)
      index += 1
      continue
    }
    if (arg === "--target") {
      const value = argv[index + 1]
      if (!value) throw new Error("Missing value for --target")
      target = value
      index += 1
      continue
    }
    throw new Error(`Unknown argument: ${arg}`)
  }
  return { keepTemp, outfile, target }
}

export const isWindowsCompileTarget = (target: string | undefined, hostPlatform: NodeJS.Platform = process.platform) =>
  target ? target.startsWith("bun-windows-") : hostPlatform === "win32"

const readProcVersion = () => {
  try {
    return readFileSync("/proc/version", "utf8")
  } catch {
    return ""
  }
}

export const isWsl2Host = (
  hostPlatform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  procVersion = readProcVersion(),
) => hostPlatform === "linux" && !!(env.WSL_DISTRO_NAME || env.WSL_INTEROP) && /WSL2|microsoft-standard-WSL2|microsoft/i.test(procVersion)

export const isInternalWindowsBridgeRun = (env: NodeJS.ProcessEnv = process.env) => env[WINDOWS_BRIDGE_ENV] === "1"
export const shouldSkipWindowsSigning = (env: NodeJS.ProcessEnv = process.env) => env[WINDOWS_SKIP_SIGN_ENV] === "1"
export const assertWindowsIconAssetExists = (
  target: string | undefined,
  iconPath = WINDOWS_ICON_PATH,
  hostPlatform: NodeJS.Platform = process.platform,
) => {
  if (!isWindowsCompileTarget(target, hostPlatform)) return
  if (existsSync(iconPath)) return
  throw new Error(`Missing Windows icon asset: ${iconPath}`)
}

export const assertWindowsBuildHostSupported = (
  target: string | undefined,
  hostPlatform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  procVersion = readProcVersion(),
) => {
  if (!isWindowsCompileTarget(target, hostPlatform)) return
  if (hostPlatform === "linux" && isWsl2Host(hostPlatform, env, procVersion)) return
  if (hostPlatform === "win32" && isInternalWindowsBridgeRun(env)) return
  if (hostPlatform === "win32") {
    throw new Error("Windows standalone builds must be launched from WSL2; direct Windows invocation is reserved for the internal bridge")
  }
  throw new Error("Windows standalone builds require WSL2 so the build can jump to native Windows Bun and sign the result")
}

const runCommand = (
  command: string,
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; stdio?: "inherit" | "pipe" } = {},
) => spawnSync(command, [...args], {
  cwd: options.cwd ?? packageRoot,
  env: options.env ?? process.env,
  encoding: "utf8",
  stdio: options.stdio ?? "pipe",
})

const runCommandChecked = (
  command: string,
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; stdio?: "inherit" | "pipe"; errorLabel?: string } = {},
) => {
  const proc = runCommand(command, args, options)
  if (proc.error) throw proc.error
  if (proc.status === 0) return proc
  const details = [proc.stdout, proc.stderr].filter(Boolean).join("").trim()
  const label = options.errorLabel ?? `${command} ${args.join(" ")}`
  throw new Error(details ? `${label} failed: ${details}` : `${label} failed with exit code ${proc.status}`)
}

const wslWindowsPath = (path: string) => runCommandChecked("wslpath", ["-w", path], { errorLabel: `wslpath -w ${path}` }).stdout.trim()

const encodePowerShellScript = (script: string) => Buffer.from(script, "utf16le").toString("base64")
const psQuote = (value: string) => value.replaceAll("'", "''")

export const renderWslWindowsBridgeScript = (options: {
  keepTemp: boolean
  outfileWin: string
  packageRootWin: string
  skipSign: boolean
  target: string
}) => [
  `$env:${WINDOWS_BRIDGE_ENV} = '1'`,
  options.skipSign
    ? `$env:${WINDOWS_SKIP_SIGN_ENV} = '1'`
    : `Remove-Item Env:${WINDOWS_SKIP_SIGN_ENV} -ErrorAction SilentlyContinue`,
  `Set-Location '${psQuote(options.packageRootWin)}'`,
  `$args = @('run', '.\\scripts\\build-standalone.ts', '--outfile', '${psQuote(options.outfileWin)}', '--target', '${psQuote(options.target)}')`,
  ...(options.keepTemp ? [`$args += '--keep-temp'`] : []),
  `& bun @args`,
  `exit $LASTEXITCODE`,
].join("\n")

export const assertWindowsSigningPrerequisites = (
  target: string | undefined,
  hostPlatform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  procVersion = readProcVersion(),
) => {
  if (!isWindowsCompileTarget(target, hostPlatform)) return
  assertWindowsIconAssetExists(target, WINDOWS_ICON_PATH, hostPlatform)
  assertWindowsBuildHostSupported(target, hostPlatform, env, procVersion)
  if (hostPlatform !== "linux" || env[WINDOWS_PREREQS_CHECKED_ENV] === "1") return
  if (!existsSync(WINDOWS_SIGN_HELPER_PATH)) throw new Error(`Missing Windows signing helper: ${WINDOWS_SIGN_HELPER_PATH}`)
  for (const command of WSL_SIGNING_COMMANDS) {
    runCommandChecked("bash", ["-lc", `command -v ${command}`], { errorLabel: `Missing required command: ${command}` })
  }
  runCommandChecked("powershell.exe", ["-NoProfile", "-Command", "Get-Command sign.exe -ErrorAction Stop | Out-Null"], {
    errorLabel: "Unable to resolve sign.exe from Windows",
  })
  runCommandChecked("az", ["account", "show", "--output", "none"], {
    errorLabel: "Azure authentication is required for Windows signing",
  })
}

export const signWindowsArtifactsFromWsl = (artifactPaths: readonly string[]) => {
  if (!artifactPaths.length) return
  const proc = spawnSync("bash", [WINDOWS_SIGN_HELPER_PATH, ...artifactPaths], {
    cwd: packageRoot,
    stdio: "inherit",
  })
  if (proc.error) throw proc.error
  if (proc.status !== 0) throw new Error(`Windows signing failed with exit code ${proc.status}`)
}

const buildWindowsStandaloneFromWsl = (options: BuildOptions) => {
  if (!options.target) throw new Error("WSL Windows bridge requires an explicit Windows Bun target")
  const packageRootWin = wslWindowsPath(packageRoot)
  const outfileWin = wslWindowsPath(options.outfile)
  const script = renderWslWindowsBridgeScript({
    keepTemp: options.keepTemp,
    outfileWin,
    packageRootWin,
    skipSign: shouldSkipWindowsSigning(),
    target: options.target,
  })
  const proc = spawnSync("powershell.exe", ["-NoProfile", "-EncodedCommand", encodePowerShellScript(script)], {
    cwd: packageRoot,
    stdio: "inherit",
  })
  if (proc.error) throw proc.error
  if (proc.status !== 0) throw new Error(`Windows bridge build failed with exit code ${proc.status}`)
}

export const normalizeWindowsVersion = (version: string) => {
  const normalized = version.trim()
  if (!WINDOWS_VERSION_PATTERN.test(normalized)) {
    throw new Error(`package.json version must be a dotted numeric Windows version for standalone Windows builds, got ${JSON.stringify(version)}`)
  }
  return normalized
}

export const getWindowsBuildMetadataArgs = (
  packageJson: Pick<PackageJsonShape, "description" | "version">,
  target: string | undefined,
  hostPlatform: NodeJS.Platform = process.platform,
  iconPath = WINDOWS_ICON_PATH,
) => {
  if (!isWindowsCompileTarget(target, hostPlatform)) return []
  if (hostPlatform !== "win32") {
    throw new Error(
      `Windows standalone builds must run on Windows so Bun can apply Windows executable metadata. Requested target: ${target ?? "<native Windows default>"}`,
    )
  }
  assertWindowsIconAssetExists(target, iconPath, hostPlatform)
  const description = packageJson.description.trim()
  if (!description) throw new Error("package.json description is required for standalone Windows executable metadata")
  const version = normalizeWindowsVersion(packageJson.version)
  return [
    "--windows-title", WINDOWS_PRODUCT_NAME,
    "--windows-publisher", WINDOWS_PUBLISHER,
    "--windows-version", version,
    "--windows-description", description,
    "--windows-copyright", WINDOWS_COPYRIGHT,
    "--windows-icon", iconPath,
  ]
}

export const buildStandaloneCompileArgs = (options: {
  bootstrapPath: string
  hostPlatform?: NodeJS.Platform
  outfile: string
  packageJson: Pick<PackageJsonShape, "description" | "version">
  target?: string
  windowsIconPath?: string
}) => {
  const buildArgs = ["build", "--compile", options.bootstrapPath, "--outfile", options.outfile]
  if (options.target) buildArgs.push("--target", options.target)
  buildArgs.push(...getWindowsBuildMetadataArgs(options.packageJson, options.target, options.hostPlatform, options.windowsIconPath))
  return buildArgs
}

export const standaloneArtifactPathFromOutfile = (
  outfile: string,
  target: string | undefined,
  hostPlatform: NodeJS.Platform = process.platform,
) => isWindowsCompileTarget(target, hostPlatform) && !outfile.toLowerCase().endsWith(".exe") ? `${outfile}.exe` : outfile

const standaloneCompileOutfile = (
  outfile: string,
  generatedRoot: string,
  target: string | undefined,
  hostPlatform: NodeJS.Platform = process.platform,
) => {
  const artifactPath = standaloneArtifactPathFromOutfile(outfile, target, hostPlatform)
  if (!isWindowsCompileTarget(target, hostPlatform) || hostPlatform !== "win32") return outfile
  return join(generatedRoot, basename(artifactPath))
}

const copyIfPresent = (sourcePath: string, targetPath: string) => {
  if (!existsSync(sourcePath)) return
  mkdirSync(dirname(targetPath), { recursive: true })
  cpSync(sourcePath, targetPath, { recursive: true })
}

const runBun = (args: string[], cwd: string) => {
  const proc = spawnSync(process.execPath, args, {
    cwd,
    stdio: "inherit",
  })
  if (proc.error) throw proc.error
  if (proc.status !== 0) throw new Error(`bun ${args.join(" ")} failed with exit code ${proc.status}`)
}

const loadPackageJson = async () => JSON.parse(await Bun.file(join(packageRoot, "package.json")).text()) as PackageJsonShape

const buildStandaloneLocally = (options: BuildOptions, packageJson: PackageJsonShape) => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "send-standalone-build-"))
  const stageRoot = join(workspaceRoot, "stage")
  const generatedRoot = join(workspaceRoot, "generated")
  mkdirSync(stageRoot, { recursive: true })
  mkdirSync(generatedRoot, { recursive: true })

  copyIfPresent(join(packageRoot, "LICENSE"), join(stageRoot, "LICENSE"))
  copyIfPresent(join(packageRoot, "README.md"), join(stageRoot, "README.md"))
  copyIfPresent(join(packageRoot, "package.json"), join(stageRoot, "package.json"))
  copyIfPresent(join(packageRoot, "runtime"), join(stageRoot, "runtime"))
  copyIfPresent(join(packageRoot, "src"), join(stageRoot, "src"))
  copyIfPresent(join(packageRoot, "tsconfig.json"), join(stageRoot, "tsconfig.json"))

  try {
    runBun(["install", "--production"], stageRoot)

    const runtimeArchive = buildRuntimeArchive(stageRoot, join(generatedRoot, "runtime.bin"))
    const bootstrapPath = join(generatedRoot, "bootstrap.ts")
    const standaloneLibPath = join(generatedRoot, "standalone-lib.ts")
    copyIfPresent(join(packageRoot, "scripts/standalone-lib.ts"), standaloneLibPath)
    writeFileSync(
      bootstrapPath,
      renderStandaloneBootstrapSource({
        archiveImportPath: toImportSpecifier(generatedRoot, runtimeArchive.archivePath),
        entrypointRelativePath: "src/index.ts",
        helperImportPath: toImportSpecifier(generatedRoot, standaloneLibPath),
        packageName: packageJson.name,
        packageVersion: packageJson.version,
        runtimeHash: runtimeArchive.hash,
      }),
    )

    mkdirSync(dirname(options.outfile), { recursive: true })
    const artifactPath = standaloneArtifactPathFromOutfile(options.outfile, options.target)
    const compileOutfile = standaloneCompileOutfile(options.outfile, generatedRoot, options.target)
    const buildArgs = buildStandaloneCompileArgs({
      bootstrapPath,
      outfile: compileOutfile,
      packageJson,
      target: options.target,
    })
    try {
      runBun(buildArgs, packageRoot)
    } catch (error) {
      rmSync(compileOutfile, { force: true })
      rmSync(options.outfile, { force: true })
      if (artifactPath !== options.outfile) rmSync(artifactPath, { force: true })
      throw error
    }
    if (compileOutfile !== artifactPath) {
      rmSync(artifactPath, { force: true })
      cpSync(compileOutfile, artifactPath)
      rmSync(compileOutfile, { force: true })
    }

    console.log(`Built ${options.outfile}`)
    console.log(`Embedded ${runtimeArchive.fileCount} files (${runtimeArchive.totalBytes} bytes) from ${workspaceRoot}`)
  } finally {
    if (!options.keepTemp) rmSync(workspaceRoot, { recursive: true, force: true })
  }
}

const main = async () => {
  const options = parseBuildArgs(process.argv.slice(2))
  if (isWindowsCompileTarget(options.target)) {
    assertWindowsSigningPrerequisites(options.target)
    if (process.platform === "linux") {
      const artifactPath = standaloneArtifactPathFromOutfile(options.outfile, options.target)
      buildWindowsStandaloneFromWsl(options)
      if (!shouldSkipWindowsSigning()) {
        try {
          signWindowsArtifactsFromWsl([artifactPath])
        } catch (error) {
          rmSync(artifactPath, { force: true })
          throw error
        }
      }
      return
    }
  }
  const packageJson = await loadPackageJson()
  buildStandaloneLocally(options, packageJson)
}

if (import.meta.main) await main()

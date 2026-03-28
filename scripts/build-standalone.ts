import { spawnSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { buildRuntimeArchive, renderStandaloneBootstrapSource } from "./standalone-lib"

type BuildOptions = {
  keepTemp: boolean
  outfile: string
  target?: string
}

type PackageJsonShape = {
  name: string
  version: string
}

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")

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

const main = async () => {
  const options = parseBuildArgs(process.argv.slice(2))
  const packageJson = await loadPackageJson()
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
    writeFileSync(
      bootstrapPath,
      renderStandaloneBootstrapSource({
        archiveImportPath: toImportSpecifier(generatedRoot, runtimeArchive.archivePath),
        entrypointRelativePath: "src/index.ts",
        helperImportPath: toImportSpecifier(generatedRoot, join(packageRoot, "scripts/standalone-lib.ts")),
        packageName: packageJson.name,
        packageVersion: packageJson.version,
        runtimeHash: runtimeArchive.hash,
      }),
    )

    mkdirSync(dirname(options.outfile), { recursive: true })
    const buildArgs = ["build", "--compile", bootstrapPath, "--outfile", options.outfile]
    if (options.target) buildArgs.push("--target", options.target)
    runBun(buildArgs, packageRoot)

    console.log(`Built ${options.outfile}`)
    console.log(`Embedded ${runtimeArchive.fileCount} files (${runtimeArchive.totalBytes} bytes) from ${workspaceRoot}`)
  } finally {
    if (!options.keepTemp) rmSync(workspaceRoot, { recursive: true, force: true })
  }
}

if (import.meta.main) await main()

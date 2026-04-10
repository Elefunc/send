import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
  assertWindowsSigningPrerequisites,
  isWsl2Host,
  WINDOWS_PREREQS_CHECKED_ENV,
} from "./build-standalone"

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const outRoot = join(packageRoot, "out")

export const standaloneCompileTargets = [
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
] as const

export type StandaloneCompileTarget = (typeof standaloneCompileTargets)[number]

export const standaloneTargetToBasename = (target: StandaloneCompileTarget) => `send-${target.replace(/^bun-/, "")}`
export const hasWindowsStandaloneTargets = (targets: readonly string[]) => targets.some(target => target.startsWith("bun-windows-"))
export const assertStandaloneAllHostSupported = (
  targets: readonly string[],
  hostPlatform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  procVersion = "",
) => {
  if (!hasWindowsStandaloneTargets(targets)) return
  if (isWsl2Host(hostPlatform, env, procVersion)) return
  throw new Error("build:standalone_all includes Windows targets and expects to run from WSL2 so it can jump to Windows Bun and code-sign the results")
}

export const standaloneTargetToArtifactName = (target: StandaloneCompileTarget) => {
  const basename = standaloneTargetToBasename(target)
  return target.includes("windows") ? `${basename}.exe` : basename
}

const runBuild = (target: StandaloneCompileTarget, outfile: string, env: NodeJS.ProcessEnv = process.env) => {
  const proc = spawnSync(
    process.execPath,
    ["run", "./scripts/build-standalone.ts", "--outfile", outfile, "--target", target],
    {
      cwd: packageRoot,
      env,
      stdio: "inherit",
    },
  )
  if (proc.error) throw proc.error
  if (proc.status !== 0) throw new Error(`build:standalone failed for ${target} with exit code ${proc.status}`)
}

const main = () => {
  const args = process.argv.slice(2)
  if (args.length > 0) throw new Error(`build:standalone_all does not accept arguments: ${args.join(" ")}`)
  assertStandaloneAllHostSupported(
    standaloneCompileTargets,
    process.platform,
    process.env,
    process.platform === "linux" ? readFileSync("/proc/version", "utf8") : "",
  )
  if (hasWindowsStandaloneTargets(standaloneCompileTargets)) assertWindowsSigningPrerequisites("bun-windows-x64")

  mkdirSync(outRoot, { recursive: true })

  try {
    for (const [index, target] of standaloneCompileTargets.entries()) {
      const basename = standaloneTargetToBasename(target)
      const artifactName = standaloneTargetToArtifactName(target)
      const outfile = join(outRoot, basename)
      const artifactPath = join(outRoot, artifactName)
      rmSync(outfile, { force: true })
      if (artifactPath !== outfile) rmSync(artifactPath, { force: true })
      console.log(`[${index + 1}/${standaloneCompileTargets.length}] Building ${target} -> out/${artifactName}`)
      const env = target.includes("windows")
        ? { ...process.env, [WINDOWS_PREREQS_CHECKED_ENV]: "1" }
        : process.env
      runBuild(target, outfile, env)
      if (!existsSync(artifactPath)) throw new Error(`Expected artifact was not created for ${target}: ${artifactPath}`)
    }
  } catch (error) {
    for (const target of standaloneCompileTargets.filter(value => value.includes("windows"))) {
      rmSync(join(outRoot, standaloneTargetToArtifactName(target)), { force: true })
    }
    throw error
  }

  console.log(`Built ${standaloneCompileTargets.length} standalone binaries in ${outRoot}`)
}

if (import.meta.main) main()

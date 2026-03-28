import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, rmSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

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

export const standaloneTargetToArtifactName = (target: StandaloneCompileTarget) => {
  const basename = standaloneTargetToBasename(target)
  return target.includes("windows") ? `${basename}.exe` : basename
}

const runBuild = (target: StandaloneCompileTarget, outfile: string) => {
  const proc = spawnSync(
    process.execPath,
    ["run", "./scripts/build-standalone.ts", "--outfile", outfile, "--target", target],
    {
      cwd: packageRoot,
      stdio: "inherit",
    },
  )
  if (proc.error) throw proc.error
  if (proc.status !== 0) throw new Error(`build:standalone failed for ${target} with exit code ${proc.status}`)
}

const main = () => {
  const args = process.argv.slice(2)
  if (args.length > 0) throw new Error(`build:standalone_all does not accept arguments: ${args.join(" ")}`)

  mkdirSync(outRoot, { recursive: true })

  for (const [index, target] of standaloneCompileTargets.entries()) {
    const basename = standaloneTargetToBasename(target)
    const artifactName = standaloneTargetToArtifactName(target)
    const outfile = join(outRoot, basename)
    const artifactPath = join(outRoot, artifactName)
    rmSync(outfile, { force: true })
    if (artifactPath !== outfile) rmSync(artifactPath, { force: true })
    console.log(`[${index + 1}/${standaloneCompileTargets.length}] Building ${target} -> out/${artifactName}`)
    runBuild(target, outfile)
    if (!existsSync(artifactPath)) throw new Error(`Expected artifact was not created for ${target}: ${artifactPath}`)
  }

  console.log(`Built ${standaloneCompileTargets.length} standalone binaries in ${outRoot}`)
}

if (import.meta.main) main()

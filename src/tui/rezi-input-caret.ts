import { readFile, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"

const PATCH_FLAG = Symbol.for("send.rezi.inputCaretPatchInstalled")

type PatchedRuntime = {
  [PATCH_FLAG]?: Set<string>
}

type FilePatchSpec = {
  relativeUrl: string
  before: string
  after: string
}

const INPUT_PATCHES: readonly FilePatchSpec[] = [
  {
    relativeUrl: "./layout/engine/intrinsic.js",
    before: "return ok(clampSize({ w: textW + 2, h: 1 }));",
    after: "return ok(clampSize({ w: textW + 3, h: 1 }));",
  },
  {
    relativeUrl: "./layout/kinds/leaf.js",
    before: "const w = Math.min(maxW, textW + 2);",
    after: "const w = Math.min(maxW, textW + 3);",
  },
] as const

const patchRuntime = globalThis as PatchedRuntime

const patchFile = async (spec: FilePatchSpec, coreIndexUrl: string) => {
  const path = fileURLToPath(new URL(spec.relativeUrl, coreIndexUrl))
  const source = await readFile(path, "utf8")
  if (source.includes(spec.after)) return
  if (!source.includes(spec.before)) throw new Error(`Unsupported @rezi-ui/core input layout at ${path}`)
  await writeFile(path, source.replace(spec.before, spec.after))
}

export const ensureReziInputCaretPatch = async () => {
  const coreIndexUrl = await import.meta.resolve("@rezi-ui/core")
  const patchedRoots = patchRuntime[PATCH_FLAG] ?? new Set<string>()
  if (patchedRoots.has(coreIndexUrl)) return
  for (const spec of INPUT_PATCHES) await patchFile(spec, coreIndexUrl)
  patchedRoots.add(coreIndexUrl)
  patchRuntime[PATCH_FLAG] = patchedRoots
}

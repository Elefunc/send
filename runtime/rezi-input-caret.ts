import { readFile, writeFile } from "node:fs/promises"

type Replacement = readonly [before: string, after: string]
type FilePatch = { relativeUrl: string; replacements: readonly Replacement[] }

const CARET_SAMPLE = "user"
const CARET_EXPECTED_WIDTH = CARET_SAMPLE.length + 3
const CARET_RULE_TEXT = "single-line ui.input width must equal value.length + 3"

const REZI_INPUT_CARET_PATCHES: readonly FilePatch[] = [
  {
    relativeUrl: "./layout/engine/intrinsic.js",
    replacements: [[
      "return ok(clampSize({ w: textW + 2, h: 1 }));",
      "return ok(clampSize({ w: textW + 3, h: 1 }));",
    ]],
  },
  {
    relativeUrl: "./layout/kinds/leaf.js",
    replacements: [[
      "const w = Math.min(maxW, textW + 2);",
      "const w = Math.min(maxW, textW + 3);",
    ]],
  },
] as const

let verifiedRoots: Set<string> | null = null

const applyFilePatch = async (baseUrl: string, patch: FilePatch) => {
  const fileUrl = new URL(patch.relativeUrl, baseUrl)
  const source = await readFile(fileUrl, "utf8")
  let next = source
  for (const [before, after] of patch.replacements) {
    if (next.includes(after)) continue
    if (!next.includes(before)) throw new Error(`Unsupported @rezi-ui/core caret patch target at ${fileUrl.href}`)
    next = next.replace(before, after)
  }
  if (next !== source) await writeFile(fileUrl, next)
}

const verifyInputCaretWidth = async () => {
  const { createTestRenderer, ui } = await import("@rezi-ui/core")
  const renderer = createTestRenderer({ viewport: { cols: 40, rows: 8 } })
  const view = renderer.render(ui.input({ id: "caret-probe", value: CARET_SAMPLE, onInput: () => {} }))
  const field = view.findById("caret-probe")
  if (!field) throw new Error("Rezi caret probe could not find the rendered input node")
  return field.rect.w
}

export const ensureReziInputCaretPatch = async () => {
  const baseUrl = await import.meta.resolve("@rezi-ui/core")
  verifiedRoots ??= new Set<string>()
  if (verifiedRoots.has(baseUrl)) return
  for (const patch of REZI_INPUT_CARET_PATCHES) await applyFilePatch(baseUrl, patch)
  const width = await verifyInputCaretWidth()
  if (width !== CARET_EXPECTED_WIDTH) {
    const installRoot = new URL("../", baseUrl).href
    throw new Error(`Rezi input caret verification failed for ${installRoot}: ${CARET_RULE_TEXT}; expected ${CARET_EXPECTED_WIDTH} for "${CARET_SAMPLE}", got ${width}. This usually means @rezi-ui/core was imported before runtime patches were applied or the upstream Rezi input layout changed.`)
  }
  verifiedRoots.add(baseUrl)
}

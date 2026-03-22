import { describe, expect, test } from "bun:test"
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const reziCorePackagePath = resolve(packageRoot, "node_modules/@rezi-ui/core")

const INTRINSIC_BEFORE = "return ok(clampSize({ w: textW + 2, h: 1 }));"
const INTRINSIC_AFTER = "return ok(clampSize({ w: textW + 3, h: 1 }));"
const LEAF_BEFORE = "const w = Math.min(maxW, textW + 2);"
const LEAF_AFTER = "const w = Math.min(maxW, textW + 3);"

const createInstalledShape = () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "send-input-caret-"))
  const sendRoot = join(tempRoot, "node_modules/@elefunc/send")
  const sendTuiDir = join(sendRoot, "src/tui")
  const reziCoreRoot = join(tempRoot, "node_modules/@rezi-ui/core")
  mkdirSync(sendRoot, { recursive: true })
  cpSync(reziCorePackagePath, reziCoreRoot, { recursive: true })
  writeFileSync(join(sendRoot, "package.json"), JSON.stringify({ name: "@elefunc/send", type: "module" }))
  cpSync(resolve(packageRoot, "src/tui"), sendTuiDir, { recursive: true })
  return {
    tempRoot,
    sendTuiDir,
    reziCoreRoot,
    intrinsicPath: join(reziCoreRoot, "dist/layout/engine/intrinsic.js"),
    leafPath: join(reziCoreRoot, "dist/layout/kinds/leaf.js"),
  }
}

const unpatchFile = (path: string, patched: string, unpatched: string) => {
  const source = readFileSync(path, "utf8")
  expect(source.includes(patched)).toBe(true)
  writeFileSync(path, source.replace(patched, unpatched))
}

describe("Rezi input caret patch", () => {
  test("patches unpatched installed-layout Rezi files and stays idempotent", async () => {
    const shape = createInstalledShape()
    try {
      unpatchFile(shape.intrinsicPath, INTRINSIC_AFTER, INTRINSIC_BEFORE)
      unpatchFile(shape.leafPath, LEAF_AFTER, LEAF_BEFORE)

      const module = await import(pathToFileURL(join(shape.sendTuiDir, "rezi-input-caret.ts")).href) as {
        ensureReziInputCaretPatch: () => Promise<void>
      }

      await module.ensureReziInputCaretPatch()
      const intrinsicOnce = readFileSync(shape.intrinsicPath, "utf8")
      const leafOnce = readFileSync(shape.leafPath, "utf8")
      expect(intrinsicOnce.includes(INTRINSIC_AFTER)).toBe(true)
      expect(leafOnce.includes(LEAF_AFTER)).toBe(true)

      await module.ensureReziInputCaretPatch()
      expect(readFileSync(shape.intrinsicPath, "utf8")).toBe(intrinsicOnce)
      expect(readFileSync(shape.leafPath, "utf8")).toBe(leafOnce)
    } finally {
      rmSync(shape.tempRoot, { recursive: true, force: true })
    }
  })

  test("patched installed-layout Rezi renders a trailing caret cell for single-line inputs", async () => {
    const shape = createInstalledShape()
    try {
      unpatchFile(shape.intrinsicPath, INTRINSIC_AFTER, INTRINSIC_BEFORE)
      unpatchFile(shape.leafPath, LEAF_AFTER, LEAF_BEFORE)

      const patchModule = await import(pathToFileURL(join(shape.sendTuiDir, "rezi-input-caret.ts")).href) as {
        ensureReziInputCaretPatch: () => Promise<void>
      }
      await patchModule.ensureReziInputCaretPatch()

      const coreModule = await import(pathToFileURL(join(shape.reziCoreRoot, "dist/index.js")).href) as {
        createTestRenderer: typeof import("@rezi-ui/core")["createTestRenderer"]
        ui: typeof import("@rezi-ui/core")["ui"]
      }
      const renderer = coreModule.createTestRenderer({ viewport: { cols: 40, rows: 8 } })
      const view = renderer.render(coreModule.ui.input({ id: "field", value: "user", onInput: () => {} }))
      const field = view.findById("field")
      expect(field === null).toBe(false)
      if (!field) throw new Error("missing input node")
      expect(field.rect.w).toBe("user".length + 3)
    } finally {
      rmSync(shape.tempRoot, { recursive: true, force: true })
    }
  })
})

import { describe, expect, test } from "bun:test"
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const reziCorePackagePath = resolve(packageRoot, "node_modules/@rezi-ui/core")

const forceTextState = (path: string, from: string, to: string) => {
  const source = readFileSync(path, "utf8")
  if (source.includes(to)) return
  expect(source.includes(from)).toBe(true)
  writeFileSync(path, source.replace(from, to))
}

const createInstalledShape = () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "send-runtime-patches-"))
  const sendRoot = join(tempRoot, "node_modules/@elefunc/send")
  const runtimeDir = join(sendRoot, "runtime")
  const reziCoreRoot = join(tempRoot, "node_modules/@rezi-ui/core")
  mkdirSync(sendRoot, { recursive: true })
  cpSync(resolve(packageRoot, "runtime"), runtimeDir, { recursive: true })
  cpSync(reziCorePackagePath, reziCoreRoot, { recursive: true })
  writeFileSync(join(sendRoot, "package.json"), JSON.stringify({ name: "@elefunc/send", type: "module" }))
  return {
    tempRoot,
    runtimeDir,
    reziCoreRoot,
    intrinsicPath: join(reziCoreRoot, "dist/layout/engine/intrinsic.js"),
    leafPath: join(reziCoreRoot, "dist/layout/kinds/leaf.js"),
    boxPath: join(reziCoreRoot, "dist/layout/kinds/box.js"),
    widgetRendererPath: join(reziCoreRoot, "dist/app/widgetRenderer.js"),
    mouseRoutingPath: join(reziCoreRoot, "dist/app/widgetRenderer/mouseRouting.js"),
  }
}

describe("runtime dependency patches", () => {
  const idempotenceShape = createInstalledShape()
  const runtimeShape = createInstalledShape()
  const failureShape = createInstalledShape()

  process.on("exit", () => {
    rmSync(idempotenceShape.tempRoot, { recursive: true, force: true })
    rmSync(runtimeShape.tempRoot, { recursive: true, force: true })
    rmSync(failureShape.tempRoot, { recursive: true, force: true })
  })

  test("patch installed-layout Rezi files and stay idempotent", async () => {
    const shape = idempotenceShape
    forceTextState(shape.intrinsicPath, "return ok(clampSize({ w: textW + 3, h: 1 }));", "return ok(clampSize({ w: textW + 2, h: 1 }));")
    forceTextState(shape.leafPath, "const w = Math.min(maxW, textW + 3);", "const w = Math.min(maxW, textW + 2);")
    forceTextState(shape.boxPath, 'const OVERFLOW_CONTENT_LIMIT = 2147483647;\n', "")
    forceTextState(shape.widgetRendererPath, "    hasPendingScrollOverride = false;\n", "")
    forceTextState(shape.mouseRoutingPath, "            ctx.markScrollOverrideDirty?.();\n", "")

    const { ensureTuiRuntimePatches } = await import(pathToFileURL(join(shape.runtimeDir, "install.ts")).href) as {
      ensureTuiRuntimePatches: () => Promise<void>
    }
    await ensureTuiRuntimePatches()

    const first = {
      intrinsic: readFileSync(shape.intrinsicPath, "utf8"),
      leaf: readFileSync(shape.leafPath, "utf8"),
      box: readFileSync(shape.boxPath, "utf8"),
      widgetRenderer: readFileSync(shape.widgetRendererPath, "utf8"),
      mouseRouting: readFileSync(shape.mouseRoutingPath, "utf8"),
    }

    expect(first.intrinsic.includes("return ok(clampSize({ w: textW + 3, h: 1 }));")).toBe(true)
    expect(first.leaf.includes("const w = Math.min(maxW, textW + 3);")).toBe(true)
    expect(first.box.includes("const OVERFLOW_CONTENT_LIMIT = 2147483647;")).toBe(true)
    expect(first.widgetRenderer.includes("hasPendingScrollOverride = false;")).toBe(true)
    expect(first.mouseRouting.includes("ctx.markScrollOverrideDirty?.();")).toBe(true)

    await ensureTuiRuntimePatches()
    expect(readFileSync(shape.intrinsicPath, "utf8")).toBe(first.intrinsic)
    expect(readFileSync(shape.widgetRendererPath, "utf8")).toBe(first.widgetRenderer)
  })

  test("patched installed-layout Rezi files behave correctly at runtime", async () => {
    const shape = runtimeShape
    forceTextState(shape.intrinsicPath, "return ok(clampSize({ w: textW + 3, h: 1 }));", "return ok(clampSize({ w: textW + 2, h: 1 }));")
    forceTextState(shape.leafPath, "const w = Math.min(maxW, textW + 3);", "const w = Math.min(maxW, textW + 2);")

    const { ensureTuiRuntimePatches } = await import(pathToFileURL(join(shape.runtimeDir, "install.ts")).href) as {
      ensureTuiRuntimePatches: () => Promise<void>
    }
    await ensureTuiRuntimePatches()

    const core = await import(pathToFileURL(join(shape.reziCoreRoot, "dist/index.js")).href) as typeof import("@rezi-ui/core")
    const renderer = core.createTestRenderer({ viewport: { cols: 40, rows: 8 } })
    const view = renderer.render(core.ui.input({ id: "field", value: "user", onInput: () => {} }))
    const field = view.findById("field")
    expect(field === null).toBe(false)
    if (!field) throw new Error("missing input node")
    expect(field.rect.w).toBe("user".length + 3)
  })

  test("fails clearly when @rezi-ui/core was already loaded before the caret patch was verified", async () => {
    const shape = failureShape
    forceTextState(shape.intrinsicPath, "return ok(clampSize({ w: textW + 3, h: 1 }));", "return ok(clampSize({ w: textW + 2, h: 1 }));")
    forceTextState(shape.leafPath, "const w = Math.min(maxW, textW + 3);", "const w = Math.min(maxW, textW + 2);")

    const core = await import(pathToFileURL(join(shape.reziCoreRoot, "dist/index.js")).href) as typeof import("@rezi-ui/core")
    const renderer = core.createTestRenderer({ viewport: { cols: 40, rows: 8 } })
    const view = renderer.render(core.ui.input({ id: "field", value: "user", onInput: () => {} }))
    const field = view.findById("field")
    expect(field === null).toBe(false)
    if (!field) throw new Error("missing input node")
    expect(field.rect.w).toBe("user".length + 2)

    const { ensureReziInputCaretPatch } = await import(pathToFileURL(join(shape.runtimeDir, "rezi-input-caret.ts")).href) as {
      ensureReziInputCaretPatch: () => Promise<void>
    }

    let message = ""
    try {
      await ensureReziInputCaretPatch()
    } catch (error) {
      message = error instanceof Error ? error.message : `${error}`
    }
    expect(message).toContain("value.length + 3")
  })
})

import { describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const reziCorePackagePath = resolve(packageRoot, "node_modules/@rezi-ui/core")
const runtimeInstallUrl = pathToFileURL(resolve(packageRoot, "runtime/install.ts")).href
const bunDgramPatchUrl = pathToFileURL(resolve(packageRoot, "runtime/bun-dgram-recv-econnrefused.ts")).href
const require = createRequire(import.meta.url)

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

const runBunEval = (script: string, timeoutMs = 4_000) => new Promise<{ stdout: string; stderr: string; exitCode: number | null }>((resolveRun, reject) => {
  const child = spawn(process.execPath, ["--eval", script], {
    cwd: packageRoot,
    stdio: ["ignore", "pipe", "pipe"],
  })
  let stdout = ""
  let stderr = ""
  const timeout = setTimeout(() => {
    child.kill("SIGKILL")
    reject(new Error(`timed out after ${timeoutMs}ms`))
  }, timeoutMs)
  child.stdout.on("data", chunk => { stdout += `${chunk}` })
  child.stderr.on("data", chunk => { stderr += `${chunk}` })
  child.on("error", error => {
    clearTimeout(timeout)
    reject(error)
  })
  child.on("close", exitCode => {
    clearTimeout(timeout)
    resolveRun({ stdout, stderr, exitCode })
  })
})

const udpRecvProbeScript = (entrypoint: "ensureSessionRuntimePatches" | "ensureTuiRuntimePatches") => `
  const { ${entrypoint} } = await import(${JSON.stringify(runtimeInstallUrl)})
  await ${entrypoint}()
  const { createSocket } = await import("node:dgram")
  const socket = createSocket("udp4")
  await new Promise(resolve => socket.bind(0, "127.0.0.1", resolve))
  socket.send(Buffer.from("x"), 9, "127.0.0.1")
  await Bun.sleep(250)
  await new Promise(resolve => socket.close(resolve))
  console.log("probe-ok")
`

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

  test("session runtime patch swallows Bun UDP recv ECONNREFUSED crashes", async () => {
    const result = await runBunEval(udpRecvProbeScript("ensureSessionRuntimePatches"))
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("probe-ok")
    expect(result.stderr).toBe("")
  })

  test("TUI runtime patch includes the Bun UDP recv ECONNREFUSED guard", async () => {
    const result = await runBunEval(udpRecvProbeScript("ensureTuiRuntimePatches"))
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("probe-ok")
    expect(result.stderr).toBe("")
  })

  test("session runtime patch stays idempotent for new UDP sockets", async () => {
    const { ensureSessionRuntimePatches } = await import(runtimeInstallUrl) as {
      ensureSessionRuntimePatches: () => Promise<void>
    }

    await ensureSessionRuntimePatches()
    await ensureSessionRuntimePatches()

    const { createSocket } = require("node:dgram") as typeof import("node:dgram")
    const socket = createSocket("udp4")
    expect(socket.listenerCount("error")).toBe(1)
    socket.close()
  })

  test("marks only Bun 1.3.12 as affected by the UDP recv ECONNREFUSED regression", async () => {
    const runtime = await import(bunDgramPatchUrl) as {
      AFFECTED_BUN_DGRAM_RECV_ECONNREFUSED_VERSIONS: Set<string>
      isAffectedBunDgramRecvEconnrefusedVersion: (version?: string) => boolean
    }

    expect([...runtime.AFFECTED_BUN_DGRAM_RECV_ECONNREFUSED_VERSIONS]).toEqual(["1.3.12"])
    expect(runtime.isAffectedBunDgramRecvEconnrefusedVersion("1.3.12")).toBe(true)
    expect(runtime.isAffectedBunDgramRecvEconnrefusedVersion("1.3.11")).toBe(false)
    expect(runtime.isAffectedBunDgramRecvEconnrefusedVersion("1.3.13")).toBe(false)
    expect(runtime.isAffectedBunDgramRecvEconnrefusedVersion("")).toBe(false)
    expect(runtime.isAffectedBunDgramRecvEconnrefusedVersion(undefined)).toBe(false)
  })
})

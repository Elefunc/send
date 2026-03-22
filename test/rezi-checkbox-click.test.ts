import { describe, expect, test } from "bun:test"
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { installCheckboxClickPatch } from "../runtime/rezi-checkbox-click"
import { defaultThemeRuntime, reziCore, widgetRendererRuntime } from "./runtime"

const { DEFAULT_TERMINAL_CAPS, TEST_MOUSE_KIND_DOWN, TEST_MOUSE_KIND_UP, makeBackendBatch, ui } = reziCore
const { WidgetRenderer } = widgetRendererRuntime
const { defaultTheme } = defaultThemeRuntime

const hooks = {
  enterRender: () => {},
  exitRender: () => {},
}

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const reziCorePackagePath = resolve(packageRoot, "node_modules/@rezi-ui/core")

const createBackend = (): any => ({
  start: async () => {},
  stop: async () => {},
  dispose: () => {},
  requestFrame: async () => {},
  pollEvents: async () => makeBackendBatch({ bytes: new Uint8Array(), droppedBatches: 0 }),
  postUserEvent: () => {},
  getCaps: async () => DEFAULT_TERMINAL_CAPS,
})

const submitOrThrow = async (renderer: any, view: () => any) => {
  const result = renderer.submitFrame(view, {}, { cols: 40, rows: 8 }, defaultTheme, hooks)
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(`${result.code}: ${result.detail}`)
  await result.inFlight
}

const clickCenter = (renderer: any, id: string) => {
  const rect = renderer.getRectByIdIndex().get(id)
  expect(rect === undefined).toBe(false)
  if (!rect) throw new Error(`missing rect for ${id}`)
  const x = rect.x + Math.floor(rect.w / 2)
  const y = rect.y + Math.floor(rect.h / 2)
  return { x, y }
}

describe("Rezi checkbox click patch", () => {
  test("toggles a checkbox on mouse click and keeps working after rerender", async () => {
    await installCheckboxClickPatch()

    let checked = false
    const changes: boolean[] = []
    const renderer = new WidgetRenderer({ backend: createBackend() })
    const renderCheckbox = () => ui.checkbox({
      id: "check",
      checked,
      onChange: next => {
        checked = next
        changes.push(next)
      },
    })

    await submitOrThrow(renderer, renderCheckbox)
    const firstClick = clickCenter(renderer, "check")

    const down = renderer.routeEngineEvent({
      kind: "mouse",
      timeMs: 1,
      x: firstClick.x,
      y: firstClick.y,
      mouseKind: TEST_MOUSE_KIND_DOWN,
      mods: 0,
      buttons: 1,
      wheelX: 0,
      wheelY: 0,
    })
    expect(down.needsRender).toBe(true)

    const up = renderer.routeEngineEvent({
      kind: "mouse",
      timeMs: 2,
      x: firstClick.x,
      y: firstClick.y,
      mouseKind: TEST_MOUSE_KIND_UP,
      mods: 0,
      buttons: 0,
      wheelX: 0,
      wheelY: 0,
    })
    expect(up.action).toEqual({ id: "check", action: "toggle", checked: true })
    expect(changes).toEqual([true])
    expect(checked).toBe(true)

    await submitOrThrow(renderer, renderCheckbox)
    const secondClick = clickCenter(renderer, "check")
    renderer.routeEngineEvent({
      kind: "mouse",
      timeMs: 3,
      x: secondClick.x,
      y: secondClick.y,
      mouseKind: TEST_MOUSE_KIND_DOWN,
      mods: 0,
      buttons: 1,
      wheelX: 0,
      wheelY: 0,
    })
    const secondUp = renderer.routeEngineEvent({
      kind: "mouse",
      timeMs: 4,
      x: secondClick.x,
      y: secondClick.y,
      mouseKind: TEST_MOUSE_KIND_UP,
      mods: 0,
      buttons: 0,
      wheelX: 0,
      wheelY: 0,
    })
    expect(secondUp.action).toEqual({ id: "check", action: "toggle", checked: false })
    expect(changes).toEqual([true, false])
    expect(checked).toBe(false)
  })

  test("cancels the click when mouse-up lands away from the checkbox", async () => {
    await installCheckboxClickPatch()

    let checked = false
    const changes: boolean[] = []
    const renderer = new WidgetRenderer({ backend: createBackend() })
    const renderCheckbox = () => ui.checkbox({
      id: "check",
      checked,
      onChange: next => {
        checked = next
        changes.push(next)
      },
    })

    await submitOrThrow(renderer, renderCheckbox)
    const { x, y } = clickCenter(renderer, "check")
    renderer.routeEngineEvent({
      kind: "mouse",
      timeMs: 1,
      x,
      y,
      mouseKind: TEST_MOUSE_KIND_DOWN,
      mods: 0,
      buttons: 1,
      wheelX: 0,
      wheelY: 0,
    })
    const up = renderer.routeEngineEvent({
      kind: "mouse",
      timeMs: 2,
      x: x + 10,
      y,
      mouseKind: TEST_MOUSE_KIND_UP,
      mods: 0,
      buttons: 0,
      wheelX: 0,
      wheelY: 0,
    })
    expect(up.action === undefined).toBe(true)
    expect(changes).toEqual([])
    expect(checked).toBe(false)
  })

  test("leaves button clicks as ordinary press actions", async () => {
    await installCheckboxClickPatch()

    let presses = 0
    const renderer = new WidgetRenderer({ backend: createBackend() })
    const renderButton = () => ui.button({
      id: "press",
      label: "Press",
      onPress: () => {
        presses += 1
      },
    })

    await submitOrThrow(renderer, renderButton)
    const { x, y } = clickCenter(renderer, "press")
    renderer.routeEngineEvent({
      kind: "mouse",
      timeMs: 1,
      x,
      y,
      mouseKind: TEST_MOUSE_KIND_DOWN,
      mods: 0,
      buttons: 1,
      wheelX: 0,
      wheelY: 0,
    })
    const up = renderer.routeEngineEvent({
      kind: "mouse",
      timeMs: 2,
      x,
      y,
      mouseKind: TEST_MOUSE_KIND_UP,
      mods: 0,
      buttons: 0,
      wheelX: 0,
      wheelY: 0,
    })
    expect(up.action).toEqual({ id: "press", action: "press" })
    expect(presses).toBe(1)
  })

  test("resolves WidgetRenderer from an installed package layout", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "send-installed-shape-"))
    try {
      const sendRoot = join(tempRoot, "node_modules/@elefunc/send")
      const sendRuntimeDir = join(sendRoot, "runtime")
      const reziCoreLink = join(tempRoot, "node_modules/@rezi-ui/core")
      mkdirSync(sendRuntimeDir, { recursive: true })
      mkdirSync(dirname(reziCoreLink), { recursive: true })
      symlinkSync(reziCorePackagePath, reziCoreLink, "dir")
      writeFileSync(join(sendRoot, "package.json"), JSON.stringify({ name: "@elefunc/send", type: "module" }))
      cpSync(resolve(packageRoot, "runtime"), sendRuntimeDir, { recursive: true })

      const installedModule = await import(pathToFileURL(join(sendRuntimeDir, "rezi-checkbox-click.ts")).href) as {
        installCheckboxClickPatch: () => Promise<void>
      }
      await installedModule.installCheckboxClickPatch()
    } finally {
      rmSync(tempRoot, { recursive: true, force: true })
    }
  })
})

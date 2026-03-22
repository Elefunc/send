import { DEFAULT_TERMINAL_CAPS, TEST_MOUSE_KIND_DOWN, TEST_MOUSE_KIND_UP, makeBackendBatch, ui, type RuntimeBackend } from "@rezi-ui/core"
import { describe, expect, test } from "bun:test"
import { WidgetRenderer, type WidgetRendererHooks } from "../node_modules/@rezi-ui/core/dist/app/widgetRenderer.js"
import { defaultTheme } from "../node_modules/@rezi-ui/core/dist/theme/defaultTheme.js"
import { installCheckboxClickPatch } from "../src/tui/rezi-checkbox-click"

const hooks: WidgetRendererHooks = {
  enterRender: () => {},
  exitRender: () => {},
}

const createBackend = (): RuntimeBackend => ({
  start: async () => {},
  stop: async () => {},
  dispose: () => {},
  requestFrame: async () => {},
  pollEvents: async () => makeBackendBatch({ bytes: new Uint8Array(), droppedBatches: 0 }),
  postUserEvent: () => {},
  getCaps: async () => DEFAULT_TERMINAL_CAPS,
})

const submitOrThrow = async (renderer: WidgetRenderer<{}>, view: () => any) => {
  const result = renderer.submitFrame(view, {}, { cols: 40, rows: 8 }, defaultTheme, hooks)
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(`${result.code}: ${result.detail}`)
  await result.inFlight
}

const clickCenter = (renderer: WidgetRenderer<{}>, id: string) => {
  const rect = renderer.getRectByIdIndex().get(id)
  expect(rect === undefined).toBe(false)
  if (!rect) throw new Error(`missing rect for ${id}`)
  const x = rect.x + Math.floor(rect.w / 2)
  const y = rect.y + Math.floor(rect.h / 2)
  return { x, y }
}

describe("Rezi checkbox click patch", () => {
  test("toggles a checkbox on mouse click and keeps working after rerender", async () => {
    installCheckboxClickPatch()

    let checked = false
    const changes: boolean[] = []
    const renderer = new WidgetRenderer<{}>({ backend: createBackend() })
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
    installCheckboxClickPatch()

    let checked = false
    const changes: boolean[] = []
    const renderer = new WidgetRenderer<{}>({ backend: createBackend() })
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
    installCheckboxClickPatch()

    let presses = 0
    const renderer = new WidgetRenderer<{}>({ backend: createBackend() })
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
})

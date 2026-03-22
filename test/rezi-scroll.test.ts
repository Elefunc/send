import { DEFAULT_TERMINAL_CAPS, TEST_MOUSE_KIND_SCROLL, makeBackendBatch, ui, type RuntimeBackend } from "@rezi-ui/core"
import { describe, expect, test } from "bun:test"
import { WidgetRenderer, type WidgetRendererHooks } from "../node_modules/@rezi-ui/core/dist/app/widgetRenderer.js"
import { defaultTheme } from "../node_modules/@rezi-ui/core/dist/theme/defaultTheme.js"

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

const renderScrollBox = (rows: number) => ui.box({
  id: "scroll-box",
  width: 12,
  height: 4,
  border: "none",
  overflow: "scroll",
}, Array.from({ length: rows }, (_, index) => ui.text(`row${index}`)))

const submitOrThrow = async (renderer: WidgetRenderer<{}>, rows: number) => {
  const result = renderer.submitFrame(() => renderScrollBox(rows), {}, { cols: 40, rows: 12 }, defaultTheme, hooks)
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(`${result.code}: ${result.detail}`)
  await result.inFlight
}

const getScrollMeta = (renderer: WidgetRenderer<{}>, id: string) => {
  const runtimeRoot = (renderer as any).committedRoot
  const layoutTree = (renderer as any).layoutTree
  const stack = [{ runtimeNode: runtimeRoot, layoutNode: layoutTree }]
  while (stack.length > 0) {
    const frame = stack.pop()
    if (!frame) continue
    const props = frame.runtimeNode?.vnode?.props ?? {}
    if (props.id === id) return frame.layoutNode?.meta ?? null
    const childCount = Math.min(frame.runtimeNode?.children?.length ?? 0, frame.layoutNode?.children?.length ?? 0)
    for (let index = childCount - 1; index >= 0; index--) {
      const runtimeChild = frame.runtimeNode.children[index]
      const layoutChild = frame.layoutNode.children[index]
      if (!runtimeChild || !layoutChild) continue
      stack.push({ runtimeNode: runtimeChild, layoutNode: layoutChild })
    }
  }
  return null
}

describe("Rezi generic scroll boxes", () => {
  test("preserve scroll position across rerenders and keep the clamped position after shrink", async () => {
    const renderer = new WidgetRenderer<{}>({ backend: createBackend() })

    await submitOrThrow(renderer, 8)
    const routed = renderer.routeEngineEvent({
      kind: "mouse",
      timeMs: 1,
      x: 1,
      y: 1,
      mouseKind: TEST_MOUSE_KIND_SCROLL,
      mods: 0,
      buttons: 0,
      wheelX: 0,
      wheelY: 1,
    })
    expect(routed.needsRender).toBe(true)

    await submitOrThrow(renderer, 8)
    expect(getScrollMeta(renderer, "scroll-box")?.scrollY).toBe(3)

    await submitOrThrow(renderer, 8)
    expect(getScrollMeta(renderer, "scroll-box")?.scrollY).toBe(3)

    await submitOrThrow(renderer, 5)
    expect(getScrollMeta(renderer, "scroll-box")?.scrollY).toBe(1)

    await submitOrThrow(renderer, 8)
    expect(getScrollMeta(renderer, "scroll-box")?.scrollY).toBe(1)
  })
})

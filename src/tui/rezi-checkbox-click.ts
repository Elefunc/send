import { WidgetRenderer } from "../../node_modules/@rezi-ui/core/dist/app/widgetRenderer.js"

const PATCH_FLAG = Symbol.for("send.rezi.checkboxClickPatchInstalled")
const CLICKABLE_CHECKBOX_IDS = Symbol.for("send.rezi.checkboxClickPressableIds")

type CheckboxProps = {
  checked: boolean
  disabled?: boolean
  onChange?: (checked: boolean) => void
}

type CheckboxRuntime = {
  checkboxById: Map<string, CheckboxProps>
  pressableIds: Set<string>
  [CLICKABLE_CHECKBOX_IDS]?: Set<string>
}

type PatchedWidgetRendererClass = typeof WidgetRenderer & {
  [PATCH_FLAG]?: boolean
}

const syncClickableCheckboxIds = (renderer: CheckboxRuntime) => {
  const nextIds = new Set<string>()
  for (const [id, checkbox] of renderer.checkboxById) {
    if (checkbox.disabled === true || typeof checkbox.onChange !== "function") continue
    nextIds.add(id)
  }
  const previousIds = renderer[CLICKABLE_CHECKBOX_IDS] ?? new Set<string>()
  for (const id of previousIds) {
    if (!nextIds.has(id)) renderer.pressableIds.delete(id)
  }
  for (const id of nextIds) renderer.pressableIds.add(id)
  renderer[CLICKABLE_CHECKBOX_IDS] = nextIds
}

export const installCheckboxClickPatch = () => {
  const WidgetRendererClass = WidgetRenderer as PatchedWidgetRendererClass
  if (WidgetRendererClass[PATCH_FLAG]) return
  WidgetRendererClass[PATCH_FLAG] = true

  const originalRouteEngineEvent = WidgetRenderer.prototype.routeEngineEvent as any

  WidgetRenderer.prototype.routeEngineEvent = function (this: unknown, event: any) {
    const renderer = this as CheckboxRuntime
    syncClickableCheckboxIds(renderer)
    const result = originalRouteEngineEvent.call(this, event) as any
    const action = result?.action
    if (event.kind !== "mouse" || !action || action.action !== "press") return result
    const checkbox = renderer.checkboxById.get(action.id)
    if (!checkbox || checkbox.disabled === true || typeof checkbox.onChange !== "function") return result
    const nextChecked = !checkbox.checked
    checkbox.onChange(nextChecked)
    return Object.freeze({
      ...result,
      needsRender: true,
      action: Object.freeze({
        id: action.id,
        action: "toggle",
        checked: nextChecked,
      }),
    })
  } as any
}

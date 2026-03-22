import { ensureTuiRuntimePatches } from "../runtime/install"

await ensureTuiRuntimePatches()

export const reziCore = await import("@rezi-ui/core")
export const widgetRendererRuntime = await import("../node_modules/@rezi-ui/core/dist/app/widgetRenderer.js")
export const defaultThemeRuntime = await import("../node_modules/@rezi-ui/core/dist/theme/defaultTheme.js")
export const sessionRuntime = await import("../src/core/session")
export const tuiRuntime = await import("../src/tui/app")
